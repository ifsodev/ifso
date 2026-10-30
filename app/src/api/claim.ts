// Link / claim relay service. The server never sees a link secret: the browser derives the link key from the
// URL fragment and sends only (id, recipient, signature). The relayer pays gas (~$0.003 on RHC) and submits
// claim(); because the signature binds the recipient, neither the relayer nor anyone copying the tx can send
// the money elsewhere. The recipient's address can be a brand-new counterfactual passkey account: receiving
// USDG needs no deployment, so the claim itself needs no UserOp.
import { getAddress, type Address, type Hex } from "viem";
import { ifsoEscrowAbi } from "../abi";
import { recoverClaimSigner, recoverAcceptSigner } from "./verify";
import { Status } from "../core/types";
import { required } from "../chain";
import { sendCall } from "../workers/tx";
import type { Deps } from "../workers/deps";
import { RateLimiter } from "./rateLimit";

export class ClaimError extends Error {
  constructor(public code: "RATE_LIMITED" | "NOT_A_LINK" | "NOT_CLAIMABLE" | "BAD_SIGNATURE" | "TOO_SMALL" | "CHALLENGE" | "TX_FAILED", msg: string) {
    super(msg);
  }
}

const F_TWO_SIDED = 1;

export async function readEscrow(deps: Deps, id: bigint) {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const [e, c] = await Promise.all([
    deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [id] }),
    deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getCondition", args: [id] }),
  ]);
  return { escrow, e, c };
}

export async function relayClaim(
  deps: Deps,
  limiter: RateLimiter,
  input: { id: bigint; recipient: Address; signature: Hex; ip: string },
): Promise<{ txHash: Hex; status: "bound" | "paid" }> {
  const ipHash = RateLimiter.ipHash(input.ip, deps.env.IP_HASH_SALT);
  // a generous brake on attempts of any kind (each costs us a read); the real claim budget is charged only after the signature checks out
  if (!(await limiter.hit(`claim-try:${ipHash}`, deps.env.CLAIM_RELAY_PER_IP_PER_HOUR * 10, 3600))) {
    throw new ClaimError("RATE_LIMITED", "too many claims from this network, try again later");
  }
  const recipient = getAddress(input.recipient);
  const { escrow, e } = await readEscrow(deps, input.id);

  if (e.linkKey === "0x0000000000000000000000000000000000000000") throw new ClaimError("NOT_A_LINK", "this payment is not a claim link");
  if ((e.flags & F_TWO_SIDED) !== 0) throw new ClaimError("CHALLENGE", "challenges are joined with accept, not claim");
  const now = BigInt(Math.floor(Date.now() / 1000));
  if ((e.status !== Status.OPEN && e.status !== Status.MET) || e.recipient !== "0x0000000000000000000000000000000000000000" || now >= e.expiry) {
    throw new ClaimError("NOT_CLAIMABLE", "already claimed, finished or expired");
  }
  // sponsor gas only above a minimum (anti-dust griefing of the paymaster/relayer budget)
  if (e.amount < BigInt(Math.round(deps.env.SPONSOR_MIN_AMOUNT_USDG * 1e6))) throw new ClaimError("TOO_SMALL", "amount below the sponsored-claim minimum");

  // offline signature check first, so forged requests never cost gas
  const signer = await recoverClaimSigner({ chainId: deps.clients.chain.id, escrow, id: input.id, recipient, conditionHash: e.conditionHash, signature: input.signature });
  if (signer.toLowerCase() !== e.linkKey.toLowerCase()) throw new ClaimError("BAD_SIGNATURE", "signature does not match this link");

  // only a request that proved the link secret counts against the shared claim budget
  if (!(await limiter.hit(`claim:${ipHash}`, deps.env.CLAIM_RELAY_PER_IP_PER_HOUR, 3600))) {
    throw new ClaimError("RATE_LIMITED", "too many claims from this network, try again later");
  }
  const r = await sendCall(
    deps,
    deps.clients.relayer,
    { address: escrow, abi: ifsoEscrowAbi, functionName: "claim", args: [input.id, recipient, input.signature] },
    { kind: "claim", escrowId: input.id.toString(), ipHash },
  );
  if (!r.ok || !r.hash) throw new ClaimError("TX_FAILED", r.error ?? "claim failed");
  return { txHash: r.hash, status: e.status === Status.MET ? "paid" : "bound" };
}

/** Gasless challenge acceptance: link signature (binds acceptor) + the acceptor's USDG EIP-3009 authorization. */
export async function relayAccept(
  deps: Deps,
  input: { id: bigint; acceptor: Address; linkSig: Hex; counterRefundTo: Address; validAfter: bigint; validBefore: bigint; authSig: Hex },
) {
  const { escrow, e } = await readEscrow(deps, input.id);
  if ((e.flags & F_TWO_SIDED) === 0) throw new ClaimError("NOT_CLAIMABLE", "not a challenge");
  if (e.linkKey !== "0x0000000000000000000000000000000000000000") {
    const signer = await recoverAcceptSigner({ chainId: deps.clients.chain.id, escrow, id: input.id, acceptor: input.acceptor, conditionHash: e.conditionHash, signature: input.linkSig });
    if (signer.toLowerCase() !== e.linkKey.toLowerCase()) throw new ClaimError("BAD_SIGNATURE", "signature does not match this invite");
  }
  const r = await sendCall(
    deps,
    deps.clients.relayer,
    { address: escrow, abi: ifsoEscrowAbi, functionName: "acceptWithAuthorization", args: [input.id, input.acceptor, input.linkSig, input.counterRefundTo, input.validAfter, input.validBefore, input.authSig] },
    { kind: "accept", escrowId: input.id.toString() },
  );
  if (!r.ok || !r.hash) throw new ClaimError("TX_FAILED", r.error ?? "accept failed");
  return { txHash: r.hash };
}

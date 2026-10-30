// Who actually signed a relayed request. Budgets and holder tiers are keyed on the address RECOVERED from the
// signature, never on an address the caller typed, so a caller cannot borrow another wallet's tier or burn its counter.
import { recoverTypedDataAddress, type Address, type Hex } from "viem";
import { ifsoEscrowAbi } from "../abi";
import { acceptAuthNonce, createAuthNonce } from "../core/condition";
import { createAuthorizationTypedData, decisionTypes, ifsoDomain, refundRedirectTypes } from "../core/typedData";
import type { CreateParams } from "../core/types";
import { required } from "../chain";
import type { Deps } from "../workers/deps";

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** EIP-3009 authorizations are EOA signatures (r, s, v): recovery is exact. Returns undefined when the signature is not well formed. */
async function recoverAuthorization(td: ReturnType<typeof createAuthorizationTypedData>, signature: Hex): Promise<Address | undefined> {
  try {
    return await recoverTypedDataAddress({ ...td, signature });
  } catch {
    return undefined;
  }
}

/** The gasless create is authorised by `from`'s EIP-3009 signature over exactly these params. Returns `from` only when it matches. */
export async function verifiedCreateSigner(deps: Deps, a: { p: CreateParams; from: Address; validAfter: bigint; validBefore: bigint; signature: Hex; fee: bigint }): Promise<Address | undefined> {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const td = createAuthorizationTypedData({ chainId: deps.clients.chain.id, usdg: deps.clients.usdg, escrow, from: a.from, value: a.p.amount + a.fee, validAfter: a.validAfter, validBefore: a.validBefore, nonce: createAuthNonce(a.from, a.p) });
  const rec = await recoverAuthorization(td, a.signature);
  return rec && same(rec, a.from) ? a.from : undefined;
}

/** The gasless accept is authorised by the acceptor's EIP-3009 signature for the counter amount. */
export async function verifiedAcceptSigner(deps: Deps, a: { id: bigint; acceptor: Address; counterRefundTo: Address; counterAmount: bigint; validAfter: bigint; validBefore: bigint; signature: Hex }): Promise<Address | undefined> {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const td = createAuthorizationTypedData({ chainId: deps.clients.chain.id, usdg: deps.clients.usdg, escrow, from: a.acceptor, value: a.counterAmount, validAfter: a.validAfter, validBefore: a.validBefore, nonce: acceptAuthNonce(a.id, a.acceptor, a.counterRefundTo) });
  const rec = await recoverAuthorization(td, a.signature);
  return rec && same(rec, a.acceptor) ? a.acceptor : undefined;
}

async function verifyEoaOr1271(deps: Deps, signer: Address, typed: { domain: ReturnType<typeof ifsoDomain>; types: any; primaryType: any; message: any }, signature: Hex): Promise<Address | undefined> {
  try {
    const rec = await recoverTypedDataAddress({ ...typed, signature });
    if (same(rec, signer)) return signer;
  } catch {
    /* not an EOA signature: try the smart-account path */
  }
  try {
    return (await deps.clients.publicClient.verifyTypedData({ address: signer, ...typed, signature } as never)) ? signer : undefined;
  } catch {
    return undefined;
  }
}

const nonceOf = async (deps: Deps, escrow: Address, who: Address) => (await deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "nonces", args: [who] })) as bigint;

/**
 * A decision may come from an EOA or an EIP-1271 smart account (passkey). The EOA case is recovered locally; a smart
 * account is checked with the chain's own signature validation. Needs the signer's current nonce from the contract.
 */
export async function verifiedDecisionSigner(deps: Deps, a: { id: bigint; signer: Address; action: number; deadline: bigint; signature: Hex }): Promise<Address | undefined> {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const nonce = await nonceOf(deps, escrow, a.signer);
  return verifyEoaOr1271(deps, a.signer, { domain: ifsoDomain(deps.clients.chain.id, escrow), types: decisionTypes, primaryType: "Decision", message: { id: a.id, action: a.action, nonce, deadline: a.deadline } }, a.signature);
}

/** A refund redirect is always signed by the escrow's sender (the contract reads the signer from storage). */
export async function verifiedRedirectSigner(deps: Deps, a: { id: bigint; sender: Address; refundTo: Address; altRefundTo: Address; deadline: bigint; signature: Hex }): Promise<Address | undefined> {
  const escrow = required(deps.clients.escrow, "ESCROW_ADDRESS");
  const nonce = await nonceOf(deps, escrow, a.sender);
  return verifyEoaOr1271(deps, a.sender, { domain: ifsoDomain(deps.clients.chain.id, escrow), types: refundRedirectTypes, primaryType: "RefundRedirect", message: { id: a.id, refundTo: a.refundTo, altRefundTo: a.altRefundTo, nonce, deadline: a.deadline } }, a.signature);
}

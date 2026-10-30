// R2: what the client builds is what the contract hashes. On a private anvil (port IFSO_TEST_ANVIL_PORT, default 8745) with the
// real contracts: the client's typed data digests equal the contract's hashClaim / hashAccept / hashDecision / hashRefundRedirect,
// and a claim made only with client functions (secret -> link -> parse -> sign -> relay) binds on chain.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { hashTypedData, type Address, type Hex } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { acceptTypedData, buildClaimUrl, claimTypedData, decisionTypedData, linkKeyAddress, parseClaimUrl, randomSecret, refundRedirectTypedData, runClaim } from "../src/client";
import { ACTION_OK } from "../src/core/types";
import { bootChain, haveAnvil, timeCondition, type TestChain } from "./helpers/chain";
import { conditionHash } from "../src/core/condition";
import { V_ACCEPTOR, V_CONDITION } from "./fixtures/vectors";
import { hashStruct } from "viem";
import { claimTypes } from "../src/core/typedData";

setDefaultTimeout(120_000);

describe("client digests match the fixed cross-language vector (no chain needed)", () => {
  test("claim struct hash from the client's types equals the Solidity vector", () => {
    const t = claimTypedData({ chainId: 4663, escrow: "0x00000000000000000000000000000000000e5c20", id: 42n, recipient: V_ACCEPTOR, conditionHash: conditionHash(V_CONDITION) });
    expect(hashStruct({ types: claimTypes, primaryType: "Claim", data: t.message })).toBe("0x94c440ffa0461675bedb6380fc72cb9d34aeb8158a7f5f2ec034a5d72ba4e424"); // not-a-key
  });
});

describe.skipIf(!haveAnvil())("client <-> contract parity on anvil", () => {
  let chain: TestChain;
  let chainId: number;
  beforeAll(async () => {
    chain = await bootChain();
    chainId = Number(await chain.pc.getChainId());
  });
  afterAll(() => chain?.stop());

  const call = <T>(fn: string, args: unknown[]) => chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: fn, args } as never) as Promise<T>;

  test("hashClaim / hashAccept / hashDecision / hashRefundRedirect equal the client's digests", async () => {
    const id = 12345n;
    const ch = ("0x" + "ab".repeat(32)) as Hex; // not-a-key
    const who = chain.alice.address;
    expect(hashTypedData(claimTypedData({ chainId, escrow: chain.escrow, id, recipient: who, conditionHash: ch }))).toBe(await call("hashClaim", [id, who, ch]));
    expect(hashTypedData(acceptTypedData({ chainId, escrow: chain.escrow, id, acceptor: who, conditionHash: ch }))).toBe(await call("hashAccept", [id, who, ch]));
    expect(hashTypedData(decisionTypedData({ chainId, escrow: chain.escrow, id, action: ACTION_OK, nonce: 7n, deadline: 1790000000n }))).toBe(await call("hashDecision", [id, ACTION_OK, 7n, 1790000000n]));
    expect(hashTypedData(refundRedirectTypedData({ chainId, escrow: chain.escrow, id, refundTo: who, altRefundTo: chain.bob.address, nonce: 3n, deadline: 1790000000n }))).toBe(await call("hashRefundRedirect", [id, who, chain.bob.address, 3n, 1790000000n]));
  });

  test("a claim link made and claimed only with client functions binds the recipient on chain", async () => {
    const secret = randomSecret();
    const t = await chain.now();
    const id = await chain.create(chain.sender, { condition: timeCondition(t + 3600n), linkKey: linkKeyAddress(secret) });
    const url = buildClaimUrl("https://example.invalid", id, secret);
    const parsed = parseClaimUrl(url);
    expect(parsed.id).toBe(id);
    let sent: Hex | undefined;
    const r = await runClaim(
      {
        chainId,
        escrow: chain.escrow,
        getEscrow: async () => {
          const e = (await call<{ conditionHash: Hex; status: number; amount: bigint }>("getEscrow", [id]));
          return { escrow: { conditionHash: e.conditionHash, status: e.status, amount: e.amount.toString() }, amountText: "20" };
        },
        relayClaim: async ({ recipient, signature }) => {
          sent = await chain.write(chain.deployer, chain.escrow, ifsoEscrowAbi as never, "claim", [id, recipient, signature]);
          return { txHash: sent, status: "bound" as const };
        },
        getRecipientAddress: async () => chain.bob.address as Address,
      },
      parsed,
    );
    expect(r.txHash).toBe(sent!);
    expect(parsed.secret.every((b) => b === 0)).toBe(true); // wiped after use
    const e = await call<{ recipient: Address }>("getEscrow", [id]);
    expect(e.recipient.toLowerCase()).toBe(chain.bob.address.toLowerCase());
  });
});

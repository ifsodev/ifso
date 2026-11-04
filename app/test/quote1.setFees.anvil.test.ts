// Audit QUOTE-1 (app half, checklist G29): the amount the sender signs is the amount the contract pulls, also after
// the owner changes the fees. setFees is instant, so the builder must read feeFor fresh for every build: the signed
// `value` is amount + the NEW feeFor(kind), and a signature made before setFees no longer goes through.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import type { Abi, Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ifsoEscrowAbi } from "../src/abi";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter, jsonSafe, paramsFromJson } from "../src/api/router";
import type { Deps } from "../src/workers/deps";
import { bootChain, bootDb, haveAnvil, havePostgres, makeTestDeps, type TestChain, type TestDb } from "./helpers/chain";

setDefaultTimeout(120_000);

type Built = {
  params: Record<string, unknown> & { amount: string; condition: { kind: number } };
  fee: string;
  total: string;
  authorization: { validAfter: string; validBefore: string; typedData: { message: { value: string } } };
};

describe.skipIf(!haveAnvil() || !havePostgres())("QUOTE-1 on anvil: signed value == amount + feeFor(kind) after setFees", () => {
  let chain: TestChain;
  let pg: TestDb;
  let deps: Deps;
  beforeAll(async () => {
    chain = await bootChain();
    pg = await bootDb();
    deps = makeTestDeps(chain, pg.db);
    await chain.mint(chain.sender.address, 1000);
  });
  afterAll(async () => {
    chain?.stop();
    await pg?.stop();
  });

  const caller = (ip: string) => appRouter.createCaller({ deps, limiter: new RateLimiter(), ip, country: "US" });
  const feeFor = (kind: number) => chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "feeFor", args: [kind] }) as Promise<bigint>;
  const build = async (ip: string) => (await caller(ip).build({ text: `/ifso ${chain.bob.address} 5 in 3 days`, sender: chain.sender.address })) as unknown as Built;
  const sign = (b: Built) => chain.sender.signTypedData(b.authorization.typedData as never);

  test("owner raises the fees; the next build signs amount + the new fee and relays; an older signature fails on chain", async () => {
    const before = await build("203.0.113.10");
    const kind = before.params.condition.kind;
    const oldFee = await feeFor(kind);
    expect(BigInt(before.authorization.typedData.message.value)).toBe(BigInt(before.params.amount) + oldFee);
    const oldSig = await sign(before);

    // instant owner call: new fees for new escrows (both under the 5 USDG caps)
    const creation = (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "creationFee" })) as bigint;
    const resolverFee = (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "resolverFee" })) as bigint;
    await chain.write(chain.deployer, chain.escrow, ifsoEscrowAbi as Abi, "setFees", [creation + 1_250_000n, resolverFee + 250_000n]);
    const newFee = await feeFor(kind);
    expect(newFee).not.toBe(oldFee);

    const after = await build("203.0.113.11");
    expect(BigInt(after.fee)).toBe(newFee);
    expect(BigInt(after.authorization.typedData.message.value)).toBe(BigInt(after.params.amount) + newFee);
    expect(BigInt(after.total)).toBe(BigInt(after.params.amount) + newFee);

    // the signature made before setFees: the api refuses it (it checks against the current fee)...
    const submitOld = caller("203.0.113.12").submit({ params: before.params, from: chain.sender.address, validAfter: before.authorization.validAfter, validBefore: before.authorization.validBefore, signature: oldSig });
    await expect(submitOld).rejects.toThrow();
    // ...and the contract refuses it too: it pulls amount + the new fee, which is not what was signed
    const relayer = chain.wallet(privateKeyToAccount(chain.relayerKey));
    const onchainOld = chain.pc.simulateContract({
      account: relayer.account!,
      address: chain.escrow,
      abi: ifsoEscrowAbi,
      functionName: "createWithAuthorization",
      args: [paramsFromJson(before.params) as never, chain.sender.address, BigInt(before.authorization.validAfter), BigInt(before.authorization.validBefore), oldSig],
    });
    await expect(onchainOld).rejects.toThrow();

    // the fresh build relays and the contract pulls exactly what was signed
    const bal0 = await chain.balance(chain.sender.address);
    const r = await caller("203.0.113.13").submit({ params: jsonSafe(after.params) as Record<string, unknown>, from: chain.sender.address, validAfter: after.authorization.validAfter, validBefore: after.authorization.validBefore, signature: await sign(after) });
    expect(r.txHash).toMatch(/^0x/);
    const e = (await chain.pc.readContract({ address: chain.escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [BigInt(r.id)] })) as { amount: bigint; sender: Address };
    expect(e.sender.toLowerCase()).toBe(chain.sender.address.toLowerCase());
    expect(e.amount).toBe(BigInt(after.params.amount));
    expect(bal0 - (await chain.balance(chain.sender.address))).toBe(BigInt(after.authorization.typedData.message.value));
  });
});


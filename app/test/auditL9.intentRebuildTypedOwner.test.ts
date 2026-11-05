// Audit L-9 regression (residual of audit L-1; PoC of 4318745): `build({intentId})` checked the intent owner against the
// TYPED `sender`, which proves nothing, and wrote params and escrowId. A stranger who saw the intent id (group-chat URL
// button /new/<id>) typed the owner's address and rebuilt the intent between the owner's build and submit, so the owner's
// genuine create no longer matched and the intent never moved. Now build writes no params or escrowId; `submit` writes
// them after the signature check. Real Postgres (test/helpers), stubbed chain.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { intents, relayTxs, tgUsers } from "../src/db/schema";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";

setDefaultTimeout(60_000);
const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000b0b0b";
const TG = 6161n;

describe.skipIf(!havePostgres())("L-9: intent params are written only by a verified submit", () => {
  let pg: TestDb;
  let deps: Deps;
  const caller = (ip: string) => appRouter.createCaller({ deps, limiter: new RateLimiter(), ip, country: "DE" });
  const owner = privateKeyToAccount(generatePrivateKey());
  const intent = async () => (await pg.db.insert(intents).values({ tgId: TG, tgChatId: -100n, draft: {}, text: `/ifso ${RECIPIENT} 10 on 2031-01-01` }).returning())[0]!;
  const row = async (id: string) => (await pg.db.select().from(intents).where(eq(intents.id, id)))[0]!;

  beforeAll(async () => {
    pg = await bootDb();
    const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async () => "0xabc" as Hex };
    deps = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
      log: () => {},
      db: pg.db,
      clients: {
        chain: { id: 4663 }, escrow: ESCROW, usdg: USDG, relayer: wallet,
        publicClient: {
          readContract: async () => 250_000n,
          simulateContract: async (req: unknown) => ({ request: req }),
          estimateContractGas: async () => 100_000n,
          getGasPrice: async () => 1_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      },
    } as unknown as Deps;
  });
  afterAll(async () => pg?.stop());
  beforeEach(async () => {
    await pg.db.delete(intents);
    await pg.db.delete(relayTxs);
    await pg.db.delete(tgUsers);
  });

  async function ownerBuildsAndSigns(id: string) {
    const b = (await caller("203.0.113.9").build({ intentId: id, sender: owner.address })) as any;
    const td = b.authorization.typedData;
    const signature = await owner.signTypedData({ ...td, message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } });
    return { b, signature };
  }
  const submit = (b: any, signature: Hex, id: string) =>
    caller("203.0.113.9").submit({ params: b.params, from: owner.address, validAfter: b.authorization.validAfter, validBefore: b.authorization.validBefore, signature, intentId: id });

  test("control: the owner's build + submit moves the intent to submitted", async () => {
    const it = await intent();
    const { b, signature } = await ownerBuildsAndSigns(it.id);
    await submit(b, signature, it.id);
    expect((await row(it.id)).state).toBe("submitted");
  });

  test("a stranger typing the owner's address between build and submit changes nothing; the owner's submit lands", async () => {
    const it = await intent();
    const { b, signature } = await ownerBuildsAndSigns(it.id);
    const before = await row(it.id);
    expect(before.params).toBeNull(); // build writes no params and no escrowId
    expect(before.escrowId).toBeNull();
    // stranger, other network, no signature, only the intent id and the owner's (public) address
    await caller("198.51.100.7").build({ intentId: it.id, sender: owner.address });
    expect(await row(it.id)).toEqual(before);
    await submit(b, signature, it.id);
    const final = await row(it.id);
    expect(final.state).toBe("submitted");
    expect(final.escrowId).toBe(String(b.id));
    expect(final.txHash).not.toBeNull();
    expect((await pg.db.select().from(tgUsers)).length).toBe(1); // notifications bound to the verified sender
  });
});

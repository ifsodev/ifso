// Audit L-1 regression: intent ids are visible in group-chat buttons, and `build({intentId})` used to overwrite an
// intent's escrowId / sender / params / state for anyone, even after submit; `submit({intentId})` then bound the bot
// user's notifications (tg_users.address) to whoever submitted. Now an intent is built only by its owner (the bot
// user's linked wallet, else the wallet that built it first), never after it was sent or expired, and submit moves
// only the intent the sender built for exactly that escrow. Real Postgres, stubbed chain. Each `expect` below FAILED
// on 6d90e71 (the stranger's build and submit went through).
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter, jsonSafe } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { buildParams } from "../src/core/builder";
import { createAuthNonce } from "../src/core/condition";
import { createAuthorizationTypedData } from "../src/core/typedData";
import { intents, relayTxs, tgUsers } from "../src/db/schema";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";

setDefaultTimeout(60_000);
const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000b0b0b";
const TG = 5151n;

describe.skipIf(!havePostgres())("audit L-1: only an intent's owner can build or submit it", () => {
  let pg: TestDb;
  let deps: Deps;
  const caller = () => appRouter.createCaller({ deps, limiter: new RateLimiter(), ip: "203.0.113.9", country: "DE" });
  const owner = privateKeyToAccount(generatePrivateKey());
  const stranger = privateKeyToAccount(generatePrivateKey());
  const intent = async (o: Partial<typeof intents.$inferInsert> = {}) =>
    (await pg.db.insert(intents).values({ tgId: TG, draft: {}, text: `/ifso ${RECIPIENT} 10 on 2031-01-01`, ...o }).returning())[0]!;
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

  test("a stranger cannot rebuild an intent the owner already built", async () => {
    const it = await intent();
    await caller().build({ intentId: it.id, sender: owner.address });
    const built = await row(it.id);
    expect(built.sender).toBe(owner.address.toLowerCase());
    await expect(caller().build({ intentId: it.id, sender: stranger.address })).rejects.toThrow("belongs to another wallet");
    expect(await row(it.id)).toEqual(built); // nothing changed
    await caller().build({ intentId: it.id, sender: owner.address }); // the owner may rebuild (a fresh deadline)
  });

  test("a bot user's linked wallet owns the intent, even before the first build", async () => {
    await pg.db.insert(tgUsers).values({ tgId: TG, address: owner.address.toLowerCase() });
    const it = await intent();
    await expect(caller().build({ intentId: it.id, sender: stranger.address })).rejects.toThrow("belongs to another wallet");
    expect((await row(it.id)).state).toBe("draft");
  });

  test("a submitted or expired intent is never rebuilt", async () => {
    const sent = await intent({ state: "submitted", sender: owner.address.toLowerCase(), escrowId: "1" });
    await expect(caller().build({ intentId: sent.id, sender: owner.address })).rejects.toThrow("already sent");
    await expect(caller().build({ intentId: sent.id, sender: stranger.address })).rejects.toThrow("already sent");
    expect((await row(sent.id)).escrowId).toBe("1");
    const old = await intent({ expiresAt: new Date(Date.now() - 1000) });
    await expect(caller().build({ intentId: old.id, sender: owner.address })).rejects.toThrow("expired");
  });

  test("a stranger's own create with the victim's intent id neither moves the intent nor binds the bot user's notifications", async () => {
    const it = await intent();
    await caller().build({ intentId: it.id, sender: owner.address });
    const params = buildParams({ draft: { kind: "TIME", at: Math.floor(Date.now() / 1000) + 86400 }, nowSec: Math.floor(Date.now() / 1000), amountUsdg: "10", twoSided: false, recipient: RECIPIENT as Address });
    const signature = await stranger.signTypedData(createAuthorizationTypedData({ chainId: 4663, usdg: USDG, escrow: ESCROW, from: stranger.address, value: params.amount + 250_000n, validAfter: 0n, validBefore: 9999999999n, nonce: createAuthNonce(stranger.address, params) }));
    await caller().submit({ params: jsonSafe(params) as Record<string, unknown>, from: stranger.address, validAfter: "0", validBefore: "9999999999", signature, intentId: it.id });
    expect((await row(it.id)).state).toBe("built"); // the stranger's create went through, the owner's intent did not move
    expect((await pg.db.select().from(tgUsers)).length).toBe(0); // and the bot user is not bound to the stranger
  });
});

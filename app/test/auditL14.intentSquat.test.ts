// Audit L-14 regression (rescore 2026-11-05): an intent id is visible in group-chat buttons (/new/<id>). When the bot
// user had no linked wallet, a squatter built the intent with its own sender (owner null, so the first builder owns it)
// and submitted its own signed create; `rememberSender` then wrote the squatter's address onto the victim's tg_users
// row. The victim's later intents were refused ("belongs to another wallet") and notifications followed the squatter.
// Now a submit never links a wallet: only the signed /link flow does. Real Postgres (test/helpers), stubbed chain.
import { afterAll, beforeAll, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { RateLimiter } from "../src/api/rateLimit";
import { appRouter } from "../src/api/router";
import { loadEnv } from "../src/config/env";
import { intents, relayTxs, tgUsers } from "../src/db/schema";
import { drizzleNotifyStore } from "../src/workers/notifier";
import type { Deps } from "../src/workers/deps";
import { bootDb, havePostgres, type TestDb } from "./helpers/chain";

setDefaultTimeout(60_000);
const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const RECIPIENT = "0x00000000000000000000000000000000000b0b0b";
const VICTIM_TG = 7171n;
const VICTIM_CHAT = -100777n;

describe.skipIf(!havePostgres())("L-14: a submit never links a wallet to the Telegram user", () => {
  let pg: TestDb;
  let deps: Deps;
  const caller = (ip: string) => appRouter.createCaller({ deps, limiter: new RateLimiter(), ip, country: "DE" });
  const victim = privateKeyToAccount(generatePrivateKey());
  const squatter = privateKeyToAccount(generatePrivateKey());
  const intent = async () => (await pg.db.insert(intents).values({ tgId: VICTIM_TG, tgChatId: VICTIM_CHAT, draft: {}, text: `/ifso ${RECIPIENT} 10 on 2031-01-01` }).returning())[0]!;
  const row = async (id: string) => (await pg.db.select().from(intents).where(eq(intents.id, id)))[0]!;
  const victimAddress = async () => (await pg.db.select().from(tgUsers).where(eq(tgUsers.tgId, VICTIM_TG)))[0]?.address ?? null;

  async function buildAndSubmit(who: PrivateKeyAccount, id: string, ip: string) {
    const b = (await caller(ip).build({ intentId: id, sender: who.address })) as any;
    const td = b.authorization.typedData;
    const signature = await who.signTypedData({ ...td, message: { ...td.message, value: BigInt(td.message.value), validAfter: BigInt(td.message.validAfter), validBefore: BigInt(td.message.validBefore) } });
    await caller(ip).submit({ params: b.params, from: who.address, validAfter: b.authorization.validAfter, validBefore: b.authorization.validBefore, signature, intentId: id });
    return b;
  }

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
    await pg.db.insert(tgUsers).values({ tgId: VICTIM_TG }); // the victim used the bot (/tz) but never linked a wallet
  });

  test("a squatter's build + submit on the victim's intent leaves tg_users.address null; the victim's intents still work", async () => {
    const squatted = await intent();
    const mine = await intent(); // another open intent of the victim, made before the squat
    await buildAndSubmit(squatter, squatted.id, "198.51.100.7");
    expect((await row(squatted.id)).state).toBe("submitted"); // the squatter's own create went through on its own money
    expect(await victimAddress()).toBeNull(); // ... but its wallet is not linked to the victim

    // the victim can still use the open intent and a new one with their own wallet
    for (const id of [mine.id, (await intent()).id]) {
      const b = await buildAndSubmit(victim, id, "203.0.113.9");
      const r = await row(id);
      expect(r.state).toBe("submitted");
      expect(r.sender).toBe(victim.address.toLowerCase());
      expect(r.escrowId).toBe(String(b.id));
    }
    expect(await victimAddress()).toBeNull(); // the victim's own submits do not link either: only /link does

    // notifications: the victim's escrows reach the victim's chat as the sender; the squatter's escrow never reaches
    // the victim through a linked address (no direct-message target for the victim's tg id)
    const store = drizzleNotifyStore(pg.db);
    const victimEscrow = (await row(mine.id)).escrowId!;
    expect(await store.targets({ name: "Created", escrowId: victimEscrow, args: {} })).toContainEqual(expect.objectContaining({ chatId: VICTIM_CHAT, role: "sender", escrowId: victimEscrow }));
    const squatterEscrow = (await row(squatted.id)).escrowId!;
    expect((await store.targets({ name: "Created", escrowId: squatterEscrow, args: {} })).filter((t) => t.chatId === VICTIM_TG)).toEqual([]);
  });

  test("a squatter's submit never overwrites or claims a Telegram user that has no row yet", async () => {
    await pg.db.delete(tgUsers);
    const squatted = await intent();
    await buildAndSubmit(squatter, squatted.id, "198.51.100.7");
    expect((await row(squatted.id)).state).toBe("submitted");
    expect(await pg.db.select().from(tgUsers)).toEqual([]);
    const next = await intent();
    await buildAndSubmit(victim, next.id, "203.0.113.9");
    expect((await row(next.id)).state).toBe("submitted");
  });
});

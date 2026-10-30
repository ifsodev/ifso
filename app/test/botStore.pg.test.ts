// The Postgres side of the bot and notifier (stores behind the interfaces): a fresh cluster on a free port,
// migrated from zero. Skips when pg_ctl is missing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pgBin, startPg, type PgCluster } from "./helpers/pg";
import { createDb } from "../src/db/client";
import { runMigrations } from "../src/db/migrate";
import { escrows, intents, questions, tgUsers, watchers } from "../src/db/schema";
import { drizzleBotStore } from "../src/bot/store";
import { handleCommand, handleAnswer } from "../src/bot/flow";
import { drizzleNotifyStore } from "../src/workers/notifier";

const bin = pgBin();

describe.skipIf(!bin)("bot + notifier stores on Postgres", () => {
  let pg: PgCluster;
  let db: ReturnType<typeof createDb>["db"];

  beforeAll(async () => {
    pg = startPg("ifso-botpg-");
    await runMigrations(pg.url);
    db = createDb(pg.url).db;
  });

  afterAll(() => pg?.stop());

  const baseEscrow = (id: string, over: Partial<typeof escrows.$inferInsert> = {}): typeof escrows.$inferInsert => ({
    id, sender: "0xaaaa000000000000000000000000000000000001", amount: "20000000", kind: 1, condition: {}, conditionHash: "0x00", expiry: new Date(Date.now() + 86400_000),
    activeFrom: new Date(), status: 1, createdBlock: 1n, createdTx: "0xtx", ...over,
  });

  test("users keep their zone, intents expire after 24 h by default, and a question is answered in place", async () => {
    const store = drizzleBotStore(db);
    await store.upsertUser(7n, { username: "alice", tz: "Asia/Dubai", tzOffsetMin: 240 });
    await store.upsertUser(7n, { username: "alice2" }); // does not wipe the zone
    expect(await store.getUser(7n)).toEqual({ tz: "Asia/Dubai", tzOffsetMin: 240 });

    const flow = { store, publicAppUrl: "https://ifso.test", tickers: new Set(["NVDA"]), now: () => Date.UTC(2026, 9, 21, 12) };
    const q = await handleCommand(flow, { tgId: 7n, chatId: 7n, username: "alice", cmd: "ifso", body: "@mia 5 on 11/01" });
    const data = (q.buttons![0]![0] as { data: string }).data;
    const [row] = await db.select().from(intents);
    const hours = (row!.expiresAt.getTime() - row!.createdAt.getTime()) / 3600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThan(24.1);
    expect(row!.recipientHandle).toBe("mia");

    const [, id, opt] = data.match(/^q:(.+):(\d)$/)!;
    const done = await handleAnswer(flow, { tgId: 7n, chatId: 7n, intentId: id!, option: Number(opt) });
    expect((done.reply!.buttons![0]![0] as { url: string }).url).toBe(`https://ifso.test/new/${id}`);
    const rows = await db.select().from(intents);
    expect(rows.length).toBe(1);
    expect(rows[0]!.text).toContain("jan");
    expect(rows[0]!.draft).toMatchObject({ kind: "TIME" });
    expect(rows[0]!.tzOffsetMin).toBe(240);
  });

  test("/mine reads the chat's escrows from intents and watchers", async () => {
    const store = drizzleBotStore(db);
    await db.insert(escrows).values([baseEscrow("101"), baseEscrow("102", { createdBlock: 2n })]);
    await db.insert(intents).values({ tgId: 55n, tgChatId: 55n, text: "x", draft: {}, escrowId: "101" });
    await db.insert(watchers).values({ escrowId: "102", tgChatId: 55n, role: "sender" });
    const rows = await store.mine(55n, 55n);
    expect(rows.map((r) => r.amount)).toEqual(["20000000", "20000000"]);
    expect(await store.mine(99n, 99n)).toEqual([]);
  });

  test("who to tell: creator chat, linked sender / recipient / referee addresses, explicit watchers, resolver questions", async () => {
    const A = "0xaaaa000000000000000000000000000000000001";
    const B = "0xbbbb000000000000000000000000000000000002";
    const R = "0xcccc000000000000000000000000000000000003";
    await db.insert(tgUsers).values([
      { tgId: 1001n, address: A.toUpperCase().replace("0X", "0x") },
      { tgId: 1002n, address: B },
      { tgId: 1003n, address: R },
    ]).onConflictDoNothing();
    await db.insert(escrows).values(baseEscrow("201", { sender: A, recipient: B, kind: 3, condition: { kind: 3, mode: 1, target: R } }));
    await db.insert(intents).values({ tgId: 1001n, tgChatId: -500n, text: "x", draft: {}, escrowId: "201" });
    await db.insert(watchers).values({ escrowId: "201", tgChatId: 1004n, role: "recipient" });

    const store = drizzleNotifyStore(db);
    const t = await store.targets({ name: "Met", escrowId: "201", args: {} });
    const by = (c: bigint) => t.filter((x) => x.chatId === c).map((x) => x.role).sort();
    expect(by(-500n)).toEqual(["sender"]);
    expect(by(1001n)).toEqual(["sender"]);
    expect(by(1002n)).toEqual(["recipient"]);
    expect(by(1003n)).toEqual(["referee"]);
    expect(by(1004n)).toEqual(["recipient"]);
    expect(t.every((x) => x.amount === "20000000")).toBe(true);

    // resolver events reach everyone watching an escrow that waits on the question
    await db.insert(questions).values({ id: "0xq1", source: "football", spec: {}, specHash: "0xh", specUri: "u", title: "Arsenal v Chelsea", providerRefs: {}, closeTime: new Date(), earliestResolve: new Date(), numOutcomes: 3 });
    await db.insert(escrows).values(baseEscrow("202", { kind: 4, questionId: "0xq1" }));
    await db.insert(watchers).values({ escrowId: "202", tgChatId: 2001n, role: "sender" });
    const q = await store.targets({ name: "Proposed", questionId: "0xq1", args: { outcome: 1 } });
    // the explicit watcher, plus the chat linked to the escrow's sender address
    expect(q.map((x) => Number(x.chatId)).sort()).toEqual([1001, 2001]);
    expect(q.every((x) => x.escrowId === "202" && x.questionTitle === "Arsenal v Chelsea")).toBe(true);
    expect(await store.targets({ name: "Met", escrowId: "999999", args: {} })).toEqual([]);
  });
});

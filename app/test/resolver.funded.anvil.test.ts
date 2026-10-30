// R1-M7 (resolver side): only questions with a funded escrow get a bond, and the walk is oldest first with a cursor.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { eq } from "drizzle-orm";
import { relayTxs } from "../src/db/schema";
import { indexerTick } from "../src/workers/indexer";
import { resolverTick } from "../src/workers/resolver";
import { haveAnvil, havePostgres } from "./helpers/chain";
import { bootResolverEnv, createOutcomeEscrow, onchainState, type ResolverEnv } from "./helpers/resolverHarness";

setDefaultTimeout(120_000);

describe.skipIf(!haveAnvil() || !havePostgres())("resolver bonds only funded questions, oldest first", () => {
  let env: ResolverEnv;
  beforeAll(async () => {
    env = await bootResolverEnv();
  });
  afterAll(async () => env?.stop());
  const proposals = async (id: string) => (await env.pg.db.select().from(relayTxs).where(eq(relayTxs.questionId, id))).filter((r) => r.kind === "propose").length;

  test("a question nobody funded is never proposed; it is proposed once an escrow exists", async () => {
    const q = await env.question(0, 3600, false);
    await env.chain.warpTo(BigInt(q.earliestResolve + 1));
    const before = await env.chain.balance(env.resolverAddress);
    await resolverTick(env.deps);
    await resolverTick(env.deps);
    expect(await proposals(q.id)).toBe(0);
    expect(await env.chain.balance(env.resolverAddress)).toBe(before); // no bond locked
    expect((await onchainState(env, q.id))[0]).toBe(1);

    await createOutcomeEscrow(env, q.id, BigInt(q.earliestResolve + 30 * 86400));
    await indexerTick(env.deps, async () => {});
    await resolverTick(env.deps);
    expect(await proposals(q.id)).toBe(1);
  });

  test("with a page of 1 the walk proposes the oldest first and reaches every question (no starvation)", async () => {
    const a = await env.question(1, 100_000);
    const b = await env.question(2, 200_000);
    const c = await env.question(3, 300_000);
    expect(a.earliestResolve < b.earliestResolve && b.earliestResolve < c.earliestResolve).toBe(true);
    await env.chain.warpTo(BigInt(c.earliestResolve + 1));
    // one question per tick; the first question (already proposed in the test above) is older and takes a turn too
    const seen: string[] = [];
    for (let i = 0; i < 6 && seen.length < 3; i++) {
      await resolverTick(env.deps, 1);
      for (const [name, id] of [["a", a.id], ["b", b.id], ["c", c.id]] as const) if (!seen.includes(name) && (await proposals(id)) > 0) seen.push(name);
    }
    expect(seen).toEqual(["a", "b", "c"]); // oldest first, none starved
    expect([await proposals(a.id), await proposals(b.id), await proposals(c.id)]).toEqual([1, 1, 1]);
  });
});

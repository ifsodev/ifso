// R2: the round finder picks the last round <= the deadline across phases, mirrors the evaluator's "next round"
// rule, and returns PENDING when the round after it does not exist yet. Phase-0 feeds (the live SPY / TSLA / AAPL
// proxies report ids like 191) and phase >= 1 feeds go through the same code. No chain needed.
import { describe, expect, test } from "bun:test";
import type { Round } from "../src/core/price";
import { Kind, Verdict, emptyCondition, type Condition } from "../src/core/types";
import { decideAtDeadline, earliestRound, lastRoundAtOrBefore, nextRound, roundIdOf, roundsAfter, type RoundSource } from "../src/workers/rounds";

const D = 1_000_000n; // a deadline

/** An in-memory proxy. Rounds are given per phase as [updatedAt, answer] in order; round numbers start at `startAgg`. */
function proxy(phases: Record<number, Array<[number, number]>>, startAgg = 1n) {
  const byId = new Map<bigint, Round>();
  let latest: Round | undefined;
  let calls = 0;
  for (const p of Object.keys(phases).map(Number).sort((a, b) => a - b)) {
    phases[p]!.forEach(([t, a], i) => {
      const id = roundIdOf(BigInt(p), startAgg + BigInt(i));
      const r = { roundId: id, answer: BigInt(a), updatedAt: BigInt(t) };
      byId.set(id, r);
      latest = r;
    });
  }
  const src: RoundSource = {
    async latest() {
      calls++;
      return latest!;
    },
    async get(id) {
      calls++;
      return byId.get(id);
    },
  };
  return { src, byId, calls: () => calls };
}

const cond = (over: Partial<Condition> = {}): Condition => ({ ...emptyCondition(), kind: Kind.PRICE, mode: 0, op: 0, threshold: 100n, deadline: D, maxStale: 3600, holdWindow: 86400, ...over });
const ctx = (now: bigint) => ({ now, createdAt: 0n, currentMultiplier: 0n });
const hourly = (from: number, n: number, answer = 100): Array<[number, number]> => Array.from({ length: n }, (_, i) => [from + i * 3600, answer]);

describe("lastRoundAtOrBefore", () => {
  for (const [label, phase, startAgg] of [["phase 1 proxy", 1, 1n], ["phase 0 proxy (live SPY style)", 0, 150n]] as const) {
    test(`${label}: picks the last round at or before the deadline in 500 rounds with few reads`, async () => {
      const first = Number(D) - 400 * 3600;
      const { src, calls } = proxy({ [phase]: hourly(first, 500) }, startAgg);
      const r = (await lastRoundAtOrBefore(src, D))!;
      expect(Number(r.updatedAt)).toBeLessThanOrEqual(Number(D));
      expect(Number(r.updatedAt) + 3600).toBeGreaterThan(Number(D));
      expect(calls()).toBeLessThan(60);
    });
  }

  test("a deadline exactly on a round picks that round; one second earlier picks the previous", async () => {
    const { src } = proxy({ 1: [[100, 1], [200, 2], [300, 3]] });
    expect((await lastRoundAtOrBefore(src, 200n))!.roundId).toBe(roundIdOf(1n, 2n));
    expect((await lastRoundAtOrBefore(src, 199n))!.roundId).toBe(roundIdOf(1n, 1n));
    expect((await lastRoundAtOrBefore(src, 99n))).toBeUndefined();
    expect((await lastRoundAtOrBefore(src, 10_000n))!.roundId).toBe(roundIdOf(1n, 3n));
  });

  test("across phases: the deadline falls in phase 1, phase 2 started after it", async () => {
    const { src } = proxy({ 1: [[100, 1], [200, 2], [300, 3]], 2: [[500, 4], [600, 5]] });
    expect((await lastRoundAtOrBefore(src, 400n))!.roundId).toBe(roundIdOf(1n, 3n));
    expect((await lastRoundAtOrBefore(src, 550n))!.roundId).toBe(roundIdOf(2n, 1n));
    expect((await lastRoundAtOrBefore(src, 250n))!.roundId).toBe(roundIdOf(1n, 2n));
  });

  test("a skipped phase number is tolerated (phases 1 and 3)", async () => {
    const { src } = proxy({ 1: [[100, 1], [200, 2]], 3: [[500, 4]] });
    expect((await lastRoundAtOrBefore(src, 400n))!.roundId).toBe(roundIdOf(1n, 2n));
  });

  test("matches a brute-force scan on 300 random feeds with random phases and gaps", async () => {
    let seed = 7;
    const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff), (seed >> 8) % n);
    for (let k = 0; k < 300; k++) {
      const startPhase = rnd(3); // 0, 1 or 2: includes phase-0 feeds
      const phases: Record<number, Array<[number, number]>> = {};
      let t = 1000;
      const all: Round[] = [];
      for (let p = startPhase; p < startPhase + 1 + rnd(3); p++) {
        const n = 1 + rnd(40);
        phases[p] = [];
        for (let i = 0; i < n; i++) {
          t += 1 + rnd(5000);
          phases[p]!.push([t, 1 + rnd(200)]);
        }
      }
      const { src, byId } = proxy(phases);
      for (const r of byId.values()) all.push(r);
      const ts = BigInt(500 + rnd(t + 2000));
      const want = all.filter((r) => r.updatedAt <= ts).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))[0];
      const got = await lastRoundAtOrBefore(src, ts);
      expect(got?.roundId ?? null).toBe(want?.roundId ?? null);
    }
  });
});

describe("nextRound", () => {
  test("id+1 in the same phase, else the first round of the next phase, else none at the head", async () => {
    const { src } = proxy({ 1: [[100, 1], [200, 2]], 2: [[300, 3]] });
    expect(await nextRound(src, roundIdOf(1n, 1n))).toMatchObject({ kind: "round", round: { roundId: roundIdOf(1n, 2n) } });
    expect(await nextRound(src, roundIdOf(1n, 2n))).toMatchObject({ kind: "round", round: { roundId: roundIdOf(2n, 1n) } });
    expect(await nextRound(src, roundIdOf(2n, 1n))).toEqual({ kind: "none" });
  });

  test("unprovable when the feed moved on but the next phase's first round is unreadable", async () => {
    const { src } = proxy({ 1: [[100, 1], [200, 2]], 3: [[300, 3]] }); // phase 2 never printed
    expect((await nextRound(src, roundIdOf(1n, 2n))).kind).toBe("unprovable");
  });

  test("roundsAfter walks across the phase boundary and stops at the head", async () => {
    const { src } = proxy({ 0: [[100, 1], [200, 2]], 1: [[300, 3], [400, 4]] });
    const out = await roundsAfter(src, roundIdOf(0n, 1n));
    expect(out.map((r) => r.updatedAt)).toEqual([200n, 300n, 400n]);
    expect((await earliestRound(src))!.roundId).toBe(roundIdOf(0n, 1n));
  });
});

describe("decideAtDeadline", () => {
  test("fresh round at the deadline: decided at once, proof is the last round before the deadline", async () => {
    const { src } = proxy({ 1: [[Number(D) - 600, 150], [Number(D) + 100, 50]] });
    const ev = await decideAtDeadline(src, cond({ threshold: 100n }), ctx(D + 10n));
    expect(ev.verdict).toBe(Verdict.TRUE);
    expect(ev.proofRoundId).toBe(roundIdOf(1n, 1n));
  });

  test("deadline not reached: PENDING", async () => {
    const { src } = proxy({ 1: [[Number(D) - 600, 150]] });
    expect((await decideAtDeadline(src, cond(), ctx(D))).verdict).toBe(Verdict.PENDING);
  });

  test("stale last round and no next round yet: PENDING with the proof ready, then VOID after the hold window", async () => {
    const { src } = proxy({ 1: [[Number(D) - 50_000, 150]] }); // 14 h old at the deadline, maxStale 1 h
    const early = await decideAtDeadline(src, cond(), ctx(D + 100n));
    expect(early.verdict).toBe(Verdict.PENDING);
    expect(early.proofRoundId).toBe(roundIdOf(1n, 1n));
    const late = await decideAtDeadline(src, cond(), ctx(D + 86400n + 1n));
    expect(late.verdict).toBe(Verdict.VOID);
    expect(late.proofRoundId).toBe(roundIdOf(1n, 1n));
  });

  test("stale last round and the first print after the deadline is the first round of the NEXT phase", async () => {
    const { src } = proxy({ 1: [[Number(D) - 50_000, 10]], 2: [[Number(D) + 7200, 150]] });
    const ev = await decideAtDeadline(src, cond({ threshold: 100n }), ctx(D + 8000n));
    expect(ev.verdict).toBe(Verdict.TRUE);
    expect(ev.proofRoundId).toBe(roundIdOf(1n, 1n)); // proof stays the last round <= deadline; the contract finds the next itself
    expect(ev.next?.roundId).toBe(roundIdOf(2n, 1n));
  });

  test("first print after the deadline is outside the hold window: VOID", async () => {
    const { src } = proxy({ 0: [[Number(D) - 50_000, 10], [Number(D) + 90_000, 150]] });
    expect((await decideAtDeadline(src, cond(), ctx(D + 100_000n))).verdict).toBe(Verdict.VOID);
  });

  test("an unreadable next phase keeps the keeper waiting (no proof, no send)", async () => {
    const { src } = proxy({ 1: [[Number(D) - 50_000, 10]], 3: [[Number(D) + 7200, 150]] });
    const ev = await decideAtDeadline(src, cond(), ctx(D + 8000n));
    expect(ev.verdict).toBe(Verdict.PENDING);
    expect(ev.unprovable).toBe(true);
  });

  test("phase-0 feed with live-style ids (191) decides the same way", async () => {
    const { src } = proxy({ 0: [[Number(D) - 600, 99], [Number(D) + 300, 200]] }, 190n);
    const ev = await decideAtDeadline(src, cond({ threshold: 100n, op: 1 }), ctx(D + 400n));
    expect(ev.proofRoundId).toBe(190n);
    expect(ev.verdict).toBe(Verdict.TRUE); // 99 <= 100
  });
});

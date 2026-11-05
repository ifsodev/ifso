// Review R3-H1: property test of the resolver's foreign-dispute policy (core/disputePolicy.ts, the exact function the
// resolver worker calls every tick). Randomized sequences of foreign proposals (honest and wrong), source states over
// time (pending / unavailable / conflicting, then final on the truth, or never), bond float sizes and budgets, with a
// panel that rules on the truth or stays silent (audit M-1 amounts: a won dispute credits bond + floor(bond / 2), a
// lost one nothing, silence floor(bond / 2)). Checked on every tick and at the end:
//  P1 a contradicted proposal is disputed whenever the float holds one bond at that point (never left to finalize)
//  P2 an honest proposal that our sources confirm before the last-call slot is never disputed
//  P3 last-call disputes never take the float below one bond
//  P4 an unconfirmed proposal is never disputed before the last-call slot, and in the slot it is disputed unless the
//     budget or the one-bond reserve says no (then a human is paged: never silent)
//  P5 a confirmed proposal is never disputed
import { describe, expect, test } from "bun:test";
import { inLastCall, planForeignDisputes, type ForeignCandidate } from "../src/core/disputePolicy";

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0), s / 2 ** 32);
}

const W = 7200; // dispute window (Deploy.s.sol: 2 h)
const LC = 1200; // RESOLVER_LAST_CALL_SECONDS default
const TICK = 60;
const PANEL_MAX = 72 * 3600;

interface Q {
  id: string;
  truth: number;
  proposed: number;
  proposedAt: number;
  finalAt: number; // sources final on the truth from this time (Infinity = never inside the run)
  disputed?: { at: number; kind: "contradicted" | "last-call"; settleAt: number; silent: boolean };
  settled?: boolean;
  paged?: boolean;
  atRisk: bigint;
}

function run(seed: number) {
  const r = rng(seed);
  const int = (a: number, b: number) => a + Math.floor(r() * (b - a + 1));
  const bond = 10_000_000n;
  let balance = bond * BigInt(int(0, 8));
  const budgetCap = r() < 0.5 ? 0 : int(1, 4);
  const n = int(1, 14);
  const qs: Q[] = Array.from({ length: n }, (_, i) => {
    const truth = int(1, 2);
    const honest = r() < 0.6;
    const proposedAt = int(0, 20_000);
    const finalAt = r() < 0.15 ? Infinity : proposedAt + int(-3600, 12_000);
    return { id: `q${String(i).padStart(2, "0")}`, truth, proposed: honest ? truth : 3 - truth, proposedAt, finalAt, atRisk: BigInt(int(1, 500)) * 1_000_000n };
  });
  const end = 20_000 + W + PANEL_MAX + TICK;
  for (let now = 0; now <= end; now += TICK) {
    // audit M-1: the panel rules on the truth (won: bond + floor(bond / 2), lost: nothing) or stays silent for its
    // whole window (each side floor(bond / 2))
    for (const q of qs) {
      if (q.disputed && !q.settled && now >= q.disputed.settleAt) {
        q.settled = true;
        if (q.disputed.silent) balance += bond / 2n;
        else if (q.proposed !== q.truth) balance += 2n * bond - (bond - bond / 2n);
      }
    }
    expect(balance >= 0n).toBe(true);
    const openLastCall = qs.filter((q) => q.disputed?.kind === "last-call" && !q.settled).length;
    const live = qs.filter((q) => now >= q.proposedAt && !q.disputed && now < q.proposedAt + W);
    const candidates: ForeignCandidate[] = live.map((q) => ({
      id: q.id,
      closesAt: q.proposedAt + W,
      atRisk: q.atRisk,
      verdict: now >= q.finalAt ? (q.proposed === q.truth ? "confirmed" : "contradicted") : "unconfirmed",
    }));
    const actions = planForeignDisputes({ now, lastCall: LC, bond, balance, budgetCap, openLastCall, candidates });
    let open = openLastCall;
    for (const act of actions) {
      const q = qs.find((x) => x.id === act.id)!;
      const c = candidates.find((x) => x.id === act.id)!;
      if (c.verdict === "confirmed") expect(act.do).toBe("leave"); // P5
      if (c.verdict === "contradicted") {
        if (balance >= bond) expect(act).toEqual({ id: q.id, do: "dispute", kind: "contradicted" }); // P1
        else expect(act.do).toBe("short");
      }
      if (c.verdict === "unconfirmed") {
        if (!inLastCall(now, c.closesAt, LC)) expect(act.do).toBe("wait"); // P4
        else if ((budgetCap === 0 || open < budgetCap) && balance >= 2n * bond) expect(act.do).toBe("dispute");
        else expect(act.do).toBe("page");
      }
      if (act.do === "page") q.paged = true;
      if (act.do === "dispute") {
        if (q.proposed === q.truth) {
          expect(act.kind).toBe("last-call"); // honest proposals are only ever disputed at last call
          expect(q.finalAt >= c.closesAt - LC).toBe(true); // P2: never one confirmed before the slot
          expect(now < q.finalAt).toBe(true);
        }
        balance -= bond;
        if (act.kind === "last-call") {
          open += 1;
          expect(balance >= bond).toBe(true); // P3
        }
        expect(balance >= 0n).toBe(true);
        const silent = r() < 0.2;
        q.disputed = { at: now, kind: act.kind, settleAt: silent ? now + PANEL_MAX : now + int(600, PANEL_MAX), silent };
      }
    }
  }
  // end state: no wrong proposal finalized silently. Each one was disputed, or it never became contradicted while a
  // bond was free (P1 above), and an unconfirmed one reaching its slot over budget was paged.
  for (const q of qs) {
    if (q.disputed) continue;
    if (q.proposed !== q.truth && q.finalAt >= q.proposedAt + W - LC) expect(q.paged || q.finalAt < q.proposedAt + W).toBe(true);
    if (q.proposed === q.truth && q.finalAt < q.proposedAt + W - LC) expect(q.disputed).toBeUndefined();
  }
  return qs;
}

describe("R3-H1 property: foreign-dispute policy over random proposals, sources and floats", () => {
  // The same 1,000 fixed seeds run on every pass, in 20 tests of 50 seeds each with an explicit 120 s hang-detector
  // timeout. One 1,000-seed test ran past bun's 5 s default at load average 76 (8.7 s); at load ~140 under
  // `taskpolicy -c background` the whole file took 412 s, so ~21 s per 50-seed chunk. Nothing here measures time.
  // The exercise check below adds up all the chunks, so the coverage bar is unchanged.
  const SEEDS = 1000;
  const CHUNK = 50;
  const totals = { chunks: 0, disputes: 0, honestSpared: 0 };
  for (let from = 1; from <= SEEDS; from += CHUNK) {
    const to = from + CHUNK - 1;
    test(`random runs, seeds ${from}-${to}: P1-P5 hold on every tick`, () => {
      for (let seed = from; seed <= to; seed++) {
        const qs = run(seed);
        totals.disputes += qs.filter((q) => q.disputed).length;
        totals.honestSpared += qs.filter((q) => q.proposed === q.truth && !q.disputed).length;
      }
      totals.chunks += 1;
    }, 120_000);
  }
  test("the 1,000 runs actually exercise both sides", () => {
    expect(totals.chunks).toBe(SEEDS / CHUNK); // every chunk ran (run the whole file, not one chunk, for this check)
    expect(totals.disputes).toBeGreaterThan(500);
    expect(totals.honestSpared).toBeGreaterThan(500);
  });

  test("float of exactly one bond: unconfirmed proposals page a human, a contradicted one still gets the bond", () => {
    const bond = 10n;
    const acts = planForeignDisputes({
      now: 7000, lastCall: LC, bond, balance: bond, openLastCall: 0,
      candidates: [
        { id: "a", verdict: "unconfirmed", closesAt: 7200, atRisk: 900n },
        { id: "b", verdict: "contradicted", closesAt: 7200, atRisk: 1n },
      ],
    });
    expect(acts).toEqual([{ id: "b", do: "dispute", kind: "contradicted" }, { id: "a", do: "page", reason: "reserve" }]);
  });

  test("audit M-1 worst case: last-call disputes all lost or all met by panel silence still leave a bond for a contradicted proposal", () => {
    const bond = 10_000_000n;
    const u = (id: string): ForeignCandidate => ({ id, verdict: "unconfirmed", closesAt: 7200, atRisk: 1n });
    const acts = planForeignDisputes({ now: 7000, lastCall: LC, bond, balance: 4n * bond, openLastCall: 0, candidates: [u("a"), u("b"), u("c"), u("d")] });
    const n = BigInt(acts.filter((a) => a.do === "dispute").length);
    expect(n).toBe(3n); // floor(float / bond) - 1
    const left = 4n * bond - n * bond;
    for (const settled of [left /* every one lost: -bond each */, left + n * (bond / 2n) /* every one silent: -bond/2 each */]) {
      const next = planForeignDisputes({ now: 9000, lastCall: LC, bond, balance: settled, openLastCall: 0, candidates: [{ id: "x", verdict: "contradicted", closesAt: 9100, atRisk: 1n }] });
      expect(next).toEqual([{ id: "x", do: "dispute", kind: "contradicted" }]);
    }
  });

  test("budget goes to the most USDG first; the explicit cap counts disputes already open", () => {
    const c = (id: string, atRisk: bigint): ForeignCandidate => ({ id, verdict: "unconfirmed", closesAt: 7200, atRisk });
    const acts = planForeignDisputes({ now: 7000, lastCall: LC, bond: 1n, balance: 100n, budgetCap: 3, openLastCall: 1, candidates: [c("small", 1n), c("big", 50n), c("mid", 10n)] });
    expect(acts).toEqual([
      { id: "big", do: "dispute", kind: "last-call" },
      { id: "mid", do: "dispute", kind: "last-call" },
      { id: "small", do: "page", reason: "budget" },
    ]);
  });
});

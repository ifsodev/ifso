// Rescore lead (d6b7a57): keeper-lag looked only at the 50 oldest open rows past their deadline. More than 50 rows that
// are undecidable for a long time (OUTCOME questions still open, AT_DEADLINE prices inside their hold window) hid every
// later row, so a real lag behind them never alerted. The scan now pages through every candidate (oldest deadline first),
// and a run that hits its probe budget says so instead of passing quietly.
import { describe, expect, test } from "bun:test";
import { LAG_PAGE, LAG_PROBE_BUDGET, scanKeeperLag, type LagCandidate, type LagProbe } from "../src/ops/monitors";
import { Kind } from "../src/core/types";

const t0 = Date.UTC(2026, 10, 5, 12, 0, 0);
const outcome = (i: number): LagCandidate => ({
  id: String(1000 + i), kind: Kind.OUTCOME, condition: { kind: Kind.OUTCOME, mode: 0, target: "0x566f2CF9745De48D7A75e10840B877344a924C96" },
  questionId: "0x" + i.toString(16).padStart(2, "0"), twoSided: false, accepted: false, activeFrom: new Date(t0 - 86400_000),
  deadline: new Date(t0 + i * 1000),
});
const time = (id: string, at: number): LagCandidate => ({
  id, kind: Kind.TIME, condition: { kind: Kind.TIME }, questionId: null, twoSided: false, accepted: false,
  activeFrom: new Date(t0 - 86400_000), deadline: new Date(at),
});
// a stand-in for the escrows query: ORDER BY deadline, id; keyset (deadline, id) > after; LIMIT n
const pages = (rows: LagCandidate[]) => {
  const sorted = [...rows].sort((a, b) => a.deadline.getTime() - b.deadline.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const calls: number[] = [];
  const fetch = async (after: { deadline: Date; id: string } | null, limit: number) => {
    calls.push(limit);
    const rest = after ? sorted.filter((r) => r.deadline > after.deadline || (r.deadline.getTime() === after.deadline.getTime() && r.id > after.id)) : sorted;
    return rest.slice(0, limit);
  };
  return { fetch, calls };
};
const openQuestions: LagProbe = { priceVerdict: async () => { throw new Error("unused"); }, outcomeState: async () => 1 }; // PENDING
const nowSec = BigInt(Math.floor(t0 / 1000) + 7 * 86400);

describe("keeper-lag scans past the first page of undecidable rows", () => {
  test("60 open OUTCOME questions with older deadlines do not hide a lagging TIME payment behind them", async () => {
    const rows = [...Array.from({ length: 60 }, (_, i) => outcome(i)), time("late", t0 + 3600_000)];
    const { fetch, calls } = pages(rows);
    const r = await scanKeeperLag(fetch, openQuestions, nowSec);
    expect(r.lagging.map((x) => x.id)).toEqual(["late"]);
    expect(r.incomplete).toBe(false);
    expect(r.probed).toBe(61);
    expect(calls.length).toBeGreaterThan(1);
    expect(LAG_PAGE).toBeLessThan(61);
  });
  test("rows with the same deadline are each looked at once across a page boundary", async () => {
    const same = Array.from({ length: LAG_PAGE + 3 }, (_, i) => ({ ...outcome(i), deadline: new Date(t0) }));
    const rows = [...same, time("z-late", t0)];
    const r = await scanKeeperLag(pages(rows).fetch, openQuestions, nowSec);
    expect(r.probed).toBe(rows.length);
    expect(r.lagging.map((x) => x.id)).toEqual(["z-late"]);
  });
  test("it stops at 5 lagging rows (the alert names at most 5)", async () => {
    const rows = Array.from({ length: 12 }, (_, i) => time(`t${i}`, t0 + i));
    const r = await scanKeeperLag(pages(rows).fetch, openQuestions, nowSec);
    expect(r.lagging.length).toBe(5);
  });
  test("a scan that runs out of its probe budget is reported incomplete, never quietly clean", async () => {
    const rows = Array.from({ length: LAG_PROBE_BUDGET + 10 }, (_, i) => outcome(i));
    const r = await scanKeeperLag(pages(rows).fetch, openQuestions, nowSec);
    expect(r.lagging).toEqual([]);
    expect(r.incomplete).toBe(true);
    expect(r.probed).toBe(LAG_PROBE_BUDGET);
  });
});

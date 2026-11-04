// PARSE-1 (audit 2026-11-04): the CSV / bulk planner is linear in its input. The router caps a run at 200,000 chars
// and 5,000 items, but a quadratic planner would still burn seconds of API CPU per request at that cap.
// Timing is made robust for a loaded CI runner: each size is timed several times and the FASTEST run is kept (noise
// only ever adds time), the absolute bound is ~30x what a laptop needs, and the scaling check compares 4x the input
// against 10x the time (linear is ~4-6x, quadratic ~16x).
import { describe, expect, test } from "bun:test";
import { parseCsv, validateRows } from "../src/api/batchPlan";

const W = (n: number) => "0x" + n.toString(16).padStart(40, "0");
// `from` gives every run its own addresses: viem caches isAddress / checksum results (LRU of 8,192), so re-planning
// the same CSV would time cache hits for 5,000 rows and real work for 10,000.
const csvOf = (n: number, from = 1) => ["address,amount", ...Array.from({ length: n }, (_, i) => `${W(from + i)},${(i % 900) + 1}.25`)].join("\n");
const plan = (csv: string) => validateRows(parseCsv(csv).rows);
let next = 1_000_000;

/**
 * Fastest-of-`runs` timings for a small and a 4x input, measured alternately so a burst of load hits both sizes.
 * Noise only ever adds time, so the minimum is the closest to the real cost. Each run gets a fresh input from make().
 */
function fastestPair<T>(small: () => T, big: () => T, fn: (x: T) => unknown, runs: number): [number, number] {
  fn(small()); // warm the JIT
  fn(big());
  let [s, b] = [Infinity, Infinity];
  for (let i = 0; i < runs; i++) {
    for (const [make, set] of [[small, (t: number) => (s = Math.min(s, t))], [big, (t: number) => (b = Math.min(b, t))]] as const) {
      const x = make();
      const t0 = performance.now();
      fn(x);
      set(performance.now() - t0);
    }
  }
  return [s, b];
}

describe("PARSE-1: batch planner is linear", () => {
  test("5,000 rows (the router's cap) plan correctly in well under a second", () => {
    const csv = csvOf(5_000);
    const t0 = performance.now();
    const { valid, problems } = plan(csv);
    const ms = performance.now() - t0;
    expect(valid.length).toBe(5_000);
    expect(problems).toEqual([]);
    expect(ms).toBeLessThan(2_000);
  });

  // 4x the rows must take < 10x the time: linear measures 4-6x (allocation and GC grow a little faster than n), quadratic ~16x.
  test("parseCsv: 4x the rows takes < 10x the time (linear, not quadratic)", () => {
    const [a, b] = [csvOf(5_000), csvOf(20_000)];
    const x10 = (csv: string) => { for (let i = 0; i < 10; i++) parseCsv(csv); }; // >= ~10 ms per sample, above timer noise
    const [t1, t4] = fastestPair(() => a, () => b, x10, 7);
    if (process.env.PARSE1_DEBUG) console.log("parse ratio", (t4 / t1).toFixed(2), t1.toFixed(1), t4.toFixed(1));
    expect(t4 / t1).toBeLessThan(10);
  });

  test("parse + validate: 4x the rows takes < 10x the time (fresh addresses every run, no cache hits)", () => {
    const [t1, t4] = fastestPair(() => csvOf(5_000, (next += 50_000)), () => csvOf(20_000, (next += 50_000)), plan, 4);
    if (process.env.PARSE1_DEBUG) console.log("plan ratio", (t4 / t1).toFixed(2), t1.toFixed(1), t4.toFixed(1));
    expect(t4 / t1).toBeLessThan(10);
  });

  test("adversarial 200,000-char inputs (one huge line, all commas, all quotes, all newlines) stay fast", () => {
    for (const csv of [",".repeat(200_000), '"'.repeat(200_000), "\n".repeat(200_000), `${W(1)},${"9".repeat(199_950)}`, " ".repeat(200_000)]) {
      const t0 = performance.now();
      plan(csv);
      expect(performance.now() - t0).toBeLessThan(2_000);
    }
  });
});

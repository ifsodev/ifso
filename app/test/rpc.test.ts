import { describe, expect, test } from "bun:test";
import { custom } from "viem";
import { getLogsChunked, makePublicClient } from "../src/chain/rpc";

describe("RPC fallback (R2)", () => {
  test("switches to the second url when the first fails, and alerts once", async () => {
    const calls: string[] = [];
    const failovers: string[] = [];
    const client = makePublicClient(["https://a.test", "https://b.test"], {
      onFailover: (i) => failovers.push(i.from),
      transportFor: (url) =>
        custom({
          async request({ method }) {
            calls.push(`${url}:${method}`);
            if (url.includes("a.test")) throw new Error("HTTP request failed: connection refused");
            return method === "eth_blockNumber" ? "0x10" : "0x1";
          },
        }),
    });
    expect(await client.getBlockNumber()).toBe(16n);
    expect(await client.getBlockNumber()).toBe(16n);
    expect(calls[0]).toStartWith("https://a.test");
    expect(calls.some((c) => c.startsWith("https://b.test"))).toBe(true);
    expect(failovers).toEqual(["https://a.test"]); // once, not per call
  });
  test("healthy primary is used and no failover fires", async () => {
    let fired = 0;
    const client = makePublicClient(["https://a.test", "https://b.test"], {
      onFailover: () => fired++,
      transportFor: () => custom({ request: async () => "0x5" }),
    });
    expect(await client.getBlockNumber()).toBe(5n);
    expect(fired).toBe(0);
  });
});

describe("getLogsChunked (R3)", () => {
  const addr = "0x00000000000000000000000000000000000e5c20" as const;
  test("splits into windows of at most maxRange blocks", async () => {
    const ranges: [bigint, bigint][] = [];
    const client = { getLogs: async (a: { fromBlock: bigint; toBlock: bigint }) => (ranges.push([a.fromBlock, a.toBlock]), []) };
    await getLogsChunked(client as never, { address: addr, fromBlock: 100n, toBlock: 4_599n, maxRange: 2000 });
    expect(ranges).toEqual([[100n, 2099n], [2100n, 4099n], [4100n, 4599n]]);
    for (const [f, t] of ranges) expect(t - f + 1n).toBeLessThanOrEqual(2000n);
  });
  test("retries 429 and busy with growing backoff, then succeeds", async () => {
    let n = 0;
    const sleeps: number[] = [];
    const client = {
      getLogs: async () => {
        n++;
        if (n === 1) throw Object.assign(new Error("HTTP request failed. Status: 429"), { status: 429 });
        if (n === 2) throw new Error("node is busy, try later");
        return [{ blockNumber: 1n } as never];
      },
    };
    const logs = await getLogsChunked(client as never, { address: addr, fromBlock: 0n, toBlock: 10n, baseDelayMs: 100, sleep: async (ms) => void sleeps.push(ms) });
    expect(logs.length).toBe(1);
    expect(sleeps).toEqual([100, 200]);
  });
  test("a non-busy error is not retried; retries are capped", async () => {
    let n = 0;
    await expect(getLogsChunked({ getLogs: async () => (n++, Promise.reject(new Error("invalid params"))) } as never, { address: addr, fromBlock: 0n, toBlock: 1n, sleep: async () => {} })).rejects.toThrow("invalid params");
    expect(n).toBe(1);
    let m = 0;
    await expect(getLogsChunked({ getLogs: async () => (m++, Promise.reject(new Error("429 too many requests"))) } as never, { address: addr, fromBlock: 0n, toBlock: 1n, retries: 3, sleep: async () => {} })).rejects.toThrow("429");
    expect(m).toBe(4);
  });
});

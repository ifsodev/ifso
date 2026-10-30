// Security review round 2: service PoCs kept as regression tests (R2-M1, R2-M3). Each asserts the SAFE behaviour and
// failed on main 42567c1. (R2-M2, the per-escrow relay cap in the router, is handled in a separate change.)
import { beforeEach, describe, expect, test } from "bun:test";
import type { Address, Hex } from "viem";
import { createApp } from "../src/api/app";
import { RateLimiter } from "../src/api/rateLimit";
import { loadEnv, missingFor } from "../src/config/env";
import { clientIp } from "../src/api/clientIp";
import { linkKeyAddress, signClaim } from "../src/core/link";
import { Status } from "../src/core/types";
import { keeperTick, resetKeeperBackoff } from "../src/workers/keeper";
import type { Deps } from "../src/workers/deps";
import { escrows } from "../src/db/schema";
import { bootDb, havePostgres } from "./helpers/chain";
import { readFileSync } from "node:fs";

const ESCROW = "0x00000000000000000000000000000000000e5c20" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";
const CH = ("0x" + "42".repeat(32)) as Hex;
const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);

/** Stub chain: every simulation succeeds unless told otherwise, every write is counted. */
function stubDeps(env: Record<string, string> = {}, simulate?: (req: { functionName: string; args: unknown[] }) => unknown) {
  const sent: Array<{ functionName: string; args: unknown[] }> = [];
  const e = { linkKey: linkKeyAddress(secret), flags: 0, status: Status.OPEN, recipient: ZERO, sender: "0x0000000000000000000000000000000000005e4d", refundTo: "0x0000000000000000000000000000000000005e4d", altRefundTo: ZERO, expiry: BigInt(Math.floor(Date.now() / 1000) + 86400), amount: 20_000_000n, conditionHash: CH };
  const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
  const q: any = { from: () => q, where: () => q, orderBy: () => q, limit: async () => [], then: (r: (v: unknown[]) => unknown) => r([]) };
  const deps = {
    env: loadEnv({ ESCROW_ADDRESS: ESCROW, ...env }),
    log: () => {},
    alert: async () => true,
    db: { insert: () => ({ values: () => ({ onConflictDoNothing: async () => {}, then: (r: () => unknown) => r() }) }), select: () => q, update: () => ({ set: () => ({ where: async () => {} }) }) },
    clients: {
      chain: { id: 4663 },
      escrow: ESCROW,
      usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
      relayer: wallet,
      keeper: wallet,
      publicClient: {
        readContract: async ({ functionName }: { functionName: string }) => (functionName === "getEscrow" ? e : functionName === "feeFor" ? 250_000n : { kind: 2 }),
        simulateContract: async (req: any) => (simulate ? simulate(req) : undefined, { request: req }),
        estimateContractGas: async () => 100_000n,
        getGasPrice: async () => 1_000_000n,
        getBlock: async () => ({ timestamp: BigInt(Math.floor(Date.now() / 1000)) }),
        waitForTransactionReceipt: async () => ({ status: "success" }),
      },
    },
  } as unknown as Deps;
  return { deps, sent };
}

// ------------------------------------------------------------------------------------------------------------------
// R2-M1: the VPS deploy (scripts/server/env.example) never sets TRUST_PROXY, so the API runs with the default "none".
//   Behind Caddy every request's socket address is 127.0.0.1, so every user on the internet shares ONE per-IP bucket:
//   one client (no funds, no valid signature) exhausts the claim relay budget for everybody.
// ------------------------------------------------------------------------------------------------------------------
/** KEY=value lines of one "[section: x]" of scripts/server/env.example, blanks and the template's addresses dropped. */
function templateEnv(section: string): Record<string, string> {
  const out: Record<string, string> = {};
  let on = false;
  for (const line of readFileSync(new URL("../scripts/server/env.example", import.meta.url), "utf8").split("\n")) {
    const s = /^# \[section: (\w+)\]/.exec(line);
    if (s) on = s[1] === section;
    else if (on && /^[A-Z_]+=./.test(line) && !/CHANGE_ME|ADDRESS=|_URL=|_URLS=|KEYSTORE=|PASSWORD_FILE=|CHAIN_ID=/.test(line)) {
      const i = line.indexOf("=");
      out[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  return out;
}

describe("R2-M1: production env leaves TRUST_PROXY at none behind Caddy", () => {
  test("the api role refuses to start in production with TRUST_PROXY unset or none", () => {
    const base = { NODE_ENV: "production", DATABASE_URL: "x", ESCROW_ADDRESS: ESCROW, REDIS_URL: "x", RELAYER_PK: "0x01", IP_HASH_SALT: "s" };
    expect(missingFor("api", base)).toEqual(["TRUST_PROXY"]);
    expect(missingFor("api", { ...base, TRUST_PROXY: "none" })).toEqual(["TRUST_PROXY"]);
    expect(missingFor("api", { ...base, TRUST_PROXY: "caddy" })).toEqual([]);
    expect(missingFor("api", { ...base, NODE_ENV: "development" })).toEqual([]); // local dev keeps the safe default
    expect(missingFor("worker", { ...base, KEEPER_PK: "0x01", RESOLVER_PK: "0x01", RESOLVER_ADDRESS: ESCROW })).toEqual([]);
    expect(templateEnv("api").HOST).toBe("127.0.0.1"); // only Caddy on the same host reaches the API
  });

  test("Caddy's client address is the LAST X-Forwarded-For hop, and a forged first entry is ignored", () => {
    // Caddy's reverse_proxy without `trusted_proxies` discards any X-Forwarded-For the client sent and writes the peer
    // address (so the last, and only, hop is the real client). If a future Caddyfile trusted an upstream proxy, Caddy
    // would APPEND the peer: the last entry is still the address Caddy itself saw. Either way the API reads the last one.
    const caddyfile = readFileSync(new URL("../scripts/server/Caddyfile", import.meta.url), "utf8").replace(/#.*$/gm, "");
    expect(caddyfile).not.toMatch(/trusted_proxies/); // no upstream trusted: the client's own XFF is replaced
    expect(caddyfile).not.toMatch(/header_up\s+[+-]?X-Forwarded-For/i); // nothing rewrites the header Caddy sets
    expect(caddyfile).toMatch(/reverse_proxy 127\.0\.0\.1:8080/);
    const h = (xff: string) => new Headers({ "x-forwarded-for": xff });
    expect(clientIp(h("203.0.113.9"), "caddy", "127.0.0.1")).toBe("203.0.113.9");
    expect(clientIp(h("6.6.6.6, 203.0.113.9"), "caddy", "127.0.0.1")).toBe("203.0.113.9"); // appended form
    expect(clientIp(h("2001:db8:1:2:3:4:5:6"), "caddy", "127.0.0.1")).toBe("2001:db8:1:2::/64");
    expect(clientIp(h(""), "caddy", "127.0.0.1")).toBe("127.0.0.1"); // no header: the socket, never a guess
    expect(clientIp(h("203.0.113.9"), "none", "127.0.0.1")).toBe("127.0.0.1"); // the old default: one bucket for all
  });

  test("the server env template sets a trusted proxy for the Caddy deployment", () => {
    const tpl = readFileSync(new URL("../scripts/server/env.example", import.meta.url), "utf8");
    expect(tpl).toMatch(/^TRUST_PROXY=caddy$/m); // fails: absent, so env.ts defaults to "none"
  });

  test("an attacker's junk claims (bad signatures) do not use up the claim relay budget of an honest user", async () => {
    // the env exactly as the VPS has it: the common and api sections of the server template (blank lines = unset)
    const { deps, sent } = stubDeps({ ...templateEnv("common"), ...templateEnv("api"), IP_HASH_SALT: "s" });
    const app = createApp(deps, new RateLimiter());
    const honestSig = await signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: "0x0000000000000000000000000000000000000b0b", conditionHash: CH });
    const caddy = (client: string) => ({ "content-type": "application/json", "x-forwarded-for": client }); // Caddy replaces XFF with the real client
    // attacker at 198.51.100.66 sends 20 claims with a garbage signature; Caddy connects from 127.0.0.1
    for (let i = 0; i < 20; i++) {
      await app.request("/trpc/claim", { method: "POST", headers: caddy("198.51.100.66"), body: JSON.stringify({ id: "9", recipient: "0x0000000000000000000000000000000000000b0b", signature: "0x" + "11".repeat(65) }) }, { socketIp: "127.0.0.1" });
    }
    // an honest user at a different address claims with a valid link signature
    await app.request("/trpc/claim", { method: "POST", headers: caddy("203.0.113.9"), body: JSON.stringify({ id: "9", recipient: "0x0000000000000000000000000000000000000b0b", signature: honestSig }) }, { socketIp: "127.0.0.1" });
    expect(sent.some((s) => s.functionName === "claim")).toBe(true); // fails: "too many claims from this network"
  });

  test("control: the same traffic with TRUST_PROXY=caddy relays the honest claim", async () => {
    const { deps, sent } = stubDeps({ NODE_ENV: "production", IP_HASH_SALT: "s", TRUST_PROXY: "caddy" });
    const app = createApp(deps, new RateLimiter());
    const honestSig = await signClaim({ secret, chainId: 4663, escrow: ESCROW, id: 9n, recipient: "0x0000000000000000000000000000000000000b0b", conditionHash: CH });
    const caddy = (client: string) => ({ "content-type": "application/json", "x-forwarded-for": client });
    for (let i = 0; i < 20; i++) {
      await app.request("/trpc/claim", { method: "POST", headers: caddy("198.51.100.66"), body: JSON.stringify({ id: "9", recipient: "0x0000000000000000000000000000000000000b0b", signature: "0x" + "11".repeat(65) }) }, { socketIp: "127.0.0.1" });
    }
    await app.request("/trpc/claim", { method: "POST", headers: caddy("203.0.113.9"), body: JSON.stringify({ id: "9", recipient: "0x0000000000000000000000000000000000000b0b", signature: honestSig }) }, { socketIp: "127.0.0.1" });
    expect(sent.some((s) => s.functionName === "claim")).toBe(true);
  });
});

// ------------------------------------------------------------------------------------------------------------------
// R2-M3: settlePrice reads `deadline <= now AND expiry > now` ordered by deadline, LIMIT 200, and skips TOUCH rows
//   without a backoff entry. 200 cheap one-sided TOUCH escrows (1 USDG + 0.25 fee each, deadline in an hour, expiry
//   400 days out, unreachable level) sit at the head of the window for 400 days: no AT_DEADLINE escrow behind them is
//   ever settled by the keeper, so met price payments go back to their senders at expiry.
// ------------------------------------------------------------------------------------------------------------------
describe("R2-M3: TOUCH rows past their deadline starve the AT_DEADLINE settle pass", () => {
  beforeEach(resetKeeperBackoff);

  function setup(touchRows: number, pg?: { db: Deps["db"]; twoSided: number; noRound: number }) {
    const now = Math.floor(Date.now() / 1000);
    const FEED = "0x000000000000000000000000000000000000f00d" as Address;
    const cond = (mode: number, deadline: number) => ({ kind: 1, mode, op: 0, source: 0, target: FEED, stockToken: ZERO, key: "0x" + "00".repeat(32), threshold: "20000000000", multiplier: "0", outcomeMask: "0", start: mode === 1 ? String(deadline - 3600) : "0", deadline: String(deadline), maxStale: mode === 1 ? 0 : 3600, holdWindow: mode === 1 ? 0 : 3 * 86400 });
    const rows = [
      ...Array.from({ length: touchRows }, (_, i) => ({ id: String(1000 + i), kind: 2, status: Status.OPEN, twoSided: false, accepted: false, deadline: new Date((now - 30 * 86400 + i) * 1000), expiry: new Date((now + 300 * 86400) * 1000), activeFrom: new Date((now - 31 * 86400) * 1000), condition: cond(1, now - 30 * 86400 + i) })),
      // unaccepted challenges (never settle, only refund at expiry) and AT_DEADLINE rows with no round in history yet
      ...Array.from({ length: pg?.twoSided ?? 0 }, (_, i) => ({ id: String(5000 + i), kind: 2, status: Status.OPEN, twoSided: true, accepted: false, deadline: new Date((now - 20 * 86400 + i) * 1000), expiry: new Date((now + 300 * 86400) * 1000), activeFrom: new Date((now - 21 * 86400) * 1000), condition: cond(0, now - 20 * 86400 + i) })),
      ...Array.from({ length: pg?.noRound ?? 0 }, (_, i) => ({ id: String(8000 + i), kind: 2, status: Status.OPEN, twoSided: false, accepted: false, deadline: new Date((now - 10 * 86400 + i) * 1000), expiry: new Date((now + 300 * 86400) * 1000), activeFrom: new Date((now - 11 * 86400) * 1000), condition: cond(0, now - 10 * 86400 + i) })),
      { id: "7", kind: 2, status: Status.OPEN, twoSided: false, accepted: false, deadline: new Date((now - 3600) * 1000), expiry: new Date((now + 3 * 86400) * 1000), activeFrom: new Date((now - 86400) * 1000), condition: cond(0, now - 3600) },
    ];
    const sent: Array<{ functionName: string; args: unknown[] }> = [];
    let call = 0;
    const R = (n: bigint) => (1n << 64n) | n;
    const rounds: Record<string, { answer: bigint; updatedAt: bigint }> = {
      [R(1n).toString()]: { answer: 21_000_000_000n, updatedAt: BigInt(now - 7200) },
      [R(2n).toString()]: { answer: 21_000_000_000n, updatedAt: BigInt(now - 1800) }, // last print before the deadline? no: deadline = now-3600
    };
    rounds[R(1n).toString()]!.updatedAt = BigInt(now - 3700); // in force at the deadline, fresh (<= maxStale)
    const wallet = { account: { address: "0x00000000000000000000000000000000000000ee" as Address }, writeContract: async (req: { functionName: string; args: unknown[] }) => (sent.push(req), "0xabc" as Hex) };
    const stubDb = {
        select: () => {
          let limit = Infinity;
          const idx = call++;
          const q: any = {
            from: () => q,
            where: () => q,
            orderBy: () => q,
            limit: (n: number) => ((limit = n), q),
            then: (res: (v: unknown[]) => unknown) => res(idx === 1 ? [...rows].sort((a, b) => a.deadline.getTime() - b.deadline.getTime()).slice(0, limit) : []),
          };
          return q;
        },
        insert: () => ({ values: () => ({ onConflictDoNothing: async () => {} }) }),
      };
    const deps = {
      env: loadEnv({ ESCROW_ADDRESS: ESCROW }),
      log: (m: string, o?: unknown) => (process.env.DBG ? console.error(m, JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? String(v) : v))) : undefined),
      alert: async () => true,
      db: pg?.db ?? stubDb,
      clients: {
        chain: { id: 4663 },
        escrow: ESCROW,
        keeper: wallet,
        publicClient: {
          getBlock: async () => ({ timestamp: BigInt(now) }),
          readContract: async ({ functionName, args }: { functionName: string; args?: unknown[] }) => {
            if (functionName === "latestRoundData") return [R(2n), rounds[R(2n).toString()]!.answer, 0n, rounds[R(2n).toString()]!.updatedAt, R(2n)];
            if (functionName === "getRoundData") {
              const r = rounds[String(args![0])];
              if (!r) throw new Error("no round");
              return [args![0], r.answer, 0n, r.updatedAt, args![0]];
            }
            throw new Error("unexpected read " + functionName);
          },
          simulateContract: async (req: unknown) => ({ request: req }),
          estimateContractGas: async () => 100_000n,
          getGasPrice: async () => 1_000_000n,
          waitForTransactionReceipt: async () => ({ status: "success" }),
        },
      },
    } as unknown as Deps;
    return { deps, sent, rows };
  }

  test("control: with no TOUCH rows the honest AT_DEADLINE escrow is settled", async () => {
    const { deps, sent } = setup(0);
    await keeperTick(deps);
    expect(sent.some((s) => s.functionName === "settle" && s.args[0] === 7n)).toBe(true);
  });

  // The PoC's stub database ignored WHERE clauses; the regression runs the real queries on Postgres.
  test.skipIf(!havePostgres())("210 untouched TOUCH rows, 210 unaccepted challenges and 210 rows with no round yet do not hide an honest AT_DEADLINE escrow (two ticks)", async () => {
    const pg = await bootDb();
    try {
      const { deps, sent, rows } = setup(210, { db: pg.db, twoSided: 210, noRound: 210 });
      for (let i = 0; i < rows.length; i += 200) {
        await pg.db.insert(escrows).values(
          rows.slice(i, i + 200).map((r) => ({ ...r, sender: ZERO, amount: "1000000", conditionHash: CH, feed: String((r.condition as { target: string }).target), createdBlock: 1n, createdTx: "0x" })),
        );
      }
      await keeperTick(deps);
      await keeperTick(deps);
      expect(sent.some((s) => s.functionName === "settle" && s.args[0] === 7n)).toBe(true);
      expect(sent.filter((s) => s.functionName === "settle").length).toBe(1); // nothing else was decidable
    } finally {
      await pg.stop();
    }
  });
});

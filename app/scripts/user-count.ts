// Real-user count straight from chain logs: no database, no Ifso server. For day-1 checks and for auditing /stats/users.
//
//   bun scripts/user-count.ts --since 2026-11-01 [--until 2026-11-08] [--rpc <url>] [--escrow <address>]
//                             [--internal 0xabc,0xdef] [--from-block <n>] [--json]
//
// Reads Created / Accepted / Claimed logs of the escrow, drops our own wallets (--internal, else INTERNAL_ADDRESSES),
// and prints unique senders, unique recipients (bound), unique challenge acceptors, escrows created and USDG volume,
// in total and per UTC day. Same rules as the server (core/stats.ts).
import { createPublicClient, decodeEventLog, getAddress, http, isAddress, type Address, type Log, type PublicClient } from "viem";
import { ifsoEscrowAbi } from "../src/abi";
import { getLogsChunked } from "../src/chain/rpc";
import { parseAddressList } from "../src/config/env";
import { formatUsdg } from "../src/core/money";
import { computeUserStats, type StatEvent, type UserStats } from "../src/core/stats";

export const DEFAULT_RPC = "https://rpc.mainnet.chain.robinhood.com";
const NAMES = new Set(["Created", "Accepted", "Claimed"]);

/** First block whose timestamp is >= ts (binary search on block timestamps), or head+1 when none is. */
export async function firstBlockAtOrAfter(pc: Pick<PublicClient, "getBlock" | "getBlockNumber">, ts: number): Promise<bigint> {
  const head = await pc.getBlockNumber();
  let lo = 0n;
  let hi = head + 1n;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const b = await pc.getBlock({ blockNumber: mid });
    if (Number(b.timestamp) >= ts) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

export async function readEvents(pc: PublicClient, escrow: Address, fromBlock: bigint, toBlock?: bigint): Promise<StatEvent[]> {
  const head = toBlock ?? (await pc.getBlockNumber());
  const logs = (await getLogsChunked(pc, { address: escrow, fromBlock, toBlock: head })) as Log[];
  const times = new Map<bigint, number>();
  const out: StatEvent[] = [];
  for (const log of logs) {
    let d: { eventName: string; args: Record<string, unknown> };
    try {
      d = decodeEventLog({ abi: ifsoEscrowAbi, data: log.data, topics: log.topics }) as never;
    } catch {
      continue;
    }
    if (!NAMES.has(d.eventName)) continue;
    let t = times.get(log.blockNumber!);
    if (t === undefined) {
      t = Number((await pc.getBlock({ blockNumber: log.blockNumber! })).timestamp);
      times.set(log.blockNumber!, t);
    }
    out.push({ name: d.eventName, blockTime: t, args: d.args });
  }
  return out;
}

export async function countUsers(opts: { pc: PublicClient; escrow: Address; sinceSec?: number; untilSec?: number; fromBlock?: bigint; internal: string[] }): Promise<UserStats> {
  const from = opts.fromBlock ?? (opts.sinceSec !== undefined ? await firstBlockAtOrAfter(opts.pc, opts.sinceSec) : 0n);
  const events = (await readEvents(opts.pc, opts.escrow, from)).filter((e) => opts.untilSec === undefined || (e.blockTime ?? 0) < opts.untilSec);
  return computeUserStats(events, opts.internal, opts.sinceSec);
}

export function render(s: UserStats): string {
  const line = (l: string, x: { uniqueSenders: number; uniqueRecipients: number; uniqueAcceptors: number; escrowsCreated: number; volumeUsdg: string }) =>
    `${l.padEnd(12)} senders ${String(x.uniqueSenders).padStart(5)}  recipients ${String(x.uniqueRecipients).padStart(5)}  acceptors ${String(x.uniqueAcceptors).padStart(5)}  escrows ${String(x.escrowsCreated).padStart(5)}  volume ${formatUsdg(BigInt(x.volumeUsdg))} USDG`;
  return [`Real users since ${s.since ?? "the start"} (our own wallets excluded)`, line("total", s), ...s.perDay.map((d) => line(d.day, d))].join("\n");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  const a = argv[i]!;
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : argv[i + 1];
}
const toSec = (label: string, d: string | undefined) => {
  if (d === undefined) return undefined;
  const ms = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00Z` : d);
  if (Number.isNaN(ms)) throw new Error(`--${label} must be a date like 2026-11-01`);
  return Math.floor(ms / 1000);
};

export async function main(argv: string[], out: (s: string) => void = console.log, client?: PublicClient): Promise<number> {
  try {
    const sinceSec = toSec("since", arg(argv, "since"));
    if (sinceSec === undefined) throw new Error("--since <date> is required (for example --since 2026-11-01)");
    const untilSec = toSec("until", arg(argv, "until"));
    const escrowArg = arg(argv, "escrow") ?? process.env.IFSO_ESCROW ?? process.env.ESCROW_ADDRESS;
    if (!escrowArg || !isAddress(escrowArg)) throw new Error("--escrow <address> is required (or set IFSO_ESCROW)");
    const internal = parseAddressList(arg(argv, "internal") ?? process.env.INTERNAL_ADDRESSES ?? "");
    const bad = internal.filter((a) => !isAddress(a));
    if (bad.length) throw new Error(`not addresses: ${bad.join(", ")}`);
    const rpc = arg(argv, "rpc") ?? process.env.IFSO_RPC ?? DEFAULT_RPC;
    const pc = client ?? (createPublicClient({ transport: http(rpc, { retryCount: 3 }) }) as PublicClient);
    const fb = arg(argv, "from-block");
    const stats = await countUsers({ pc, escrow: getAddress(escrowArg), sinceSec, untilSec, fromBlock: fb ? BigInt(fb) : undefined, internal });
    out(argv.includes("--json") ? JSON.stringify(stats, null, 2) : render(stats));
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));

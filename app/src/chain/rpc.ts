// RPC access: ordered fallback across the configured URLs, and chunked getLogs with backoff.
import {
  createPublicClient,
  custom,
  fallback,
  http,
  type AbiEvent,
  type Address,
  type Chain,
  type Log,
  type PublicClient,
  type Transport,
} from "viem";

export interface RpcOptions {
  chain?: Chain;
  /** Build the transport for one URL. Tests inject mocks; production uses http. */
  transportFor?: (url: string) => Transport;
  /** Called once when a call first has to leave the primary URL (and again after it recovered and failed anew). */
  onFailover?: (info: { from: string; error: string }) => void;
  onRecover?: () => void;
}

const defaultTransport = (url: string): Transport => http(url, { batch: true, retryCount: 1, timeout: 10_000 });

/** Transport over `urls` tried strictly in the configured order (no latency ranking). */
export function makeTransport(urls: string[], opts: RpcOptions = {}): Transport {
  if (urls.length === 0) throw new Error("no RPC urls configured");
  const make = opts.transportFor ?? defaultTransport;
  let failedOver = false;
  const wrapped = urls.map((url, i): Transport => (args) => {
    const inner = make(url)(args);
    return custom({
      async request(req) {
        try {
          const res = await inner.request(req);
          if (i === 0 && failedOver) {
            failedOver = false;
            opts.onRecover?.();
          }
          return res;
        } catch (e) {
          if (i < urls.length - 1 && !failedOver) {
            failedOver = true;
            opts.onFailover?.({ from: url.replace(/\/\/([^/@]+@)?/, "//"), error: String((e as Error).message ?? e).slice(0, 200) });
          }
          throw e;
        }
      },
    })(args);
  });
  return urls.length === 1 ? wrapped[0]! : fallback(wrapped, { rank: false, retryCount: 0 });
}

export function makePublicClient(urls: string[], opts: RpcOptions = {}): PublicClient {
  return createPublicClient({ chain: opts.chain, transport: makeTransport(urls, opts) }) as PublicClient;
}

const isBusy = (e: unknown) => {
  const m = String((e as { message?: string; details?: string })?.message ?? e) + String((e as { details?: string })?.details ?? "");
  return /\b429\b|too many requests|rate.?limit|\bbusy\b|try again|timeout/i.test(m) || (e as { status?: number })?.status === 429;
};

export interface LogsParams {
  address: Address | Address[];
  events?: readonly AbiEvent[];
  fromBlock: bigint;
  toBlock: bigint;
  maxRange?: number;
  /** Backoff controls (tests set these small). */
  retries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** eth_getLogs over [fromBlock, toBlock] in windows of at most maxRange blocks; 429 / busy answers back off and retry. */
export async function getLogsChunked(client: Pick<PublicClient, "getLogs">, p: LogsParams): Promise<Log[]> {
  const maxRange = BigInt(p.maxRange ?? 2000);
  const retries = p.retries ?? 6;
  const base = p.baseDelayMs ?? 400;
  const sleep = p.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const out: Log[] = [];
  for (let from = p.fromBlock; from <= p.toBlock; from += maxRange) {
    const to = from + maxRange - 1n > p.toBlock ? p.toBlock : from + maxRange - 1n;
    for (let attempt = 0; ; attempt++) {
      try {
        const logs = await (client.getLogs as (a: unknown) => Promise<Log[]>)({
          address: p.address,
          events: p.events,
          fromBlock: from,
          toBlock: to,
        });
        out.push(...logs);
        break;
      } catch (e) {
        if (attempt >= retries || !isBusy(e)) throw e;
        await sleep(Math.min(base * 2 ** attempt, 15_000));
      }
    }
  }
  return out;
}

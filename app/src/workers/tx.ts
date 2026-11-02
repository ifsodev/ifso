// The single place a hot key signs and sends. Simulate first (an eth_call that would revert costs nothing),
// size gas from an estimate with headroom, cap the fee at 1.5x the current gas price, and serialise sends per
// account inside this process so the keeper sweep and the price watcher never race for one nonce.
import { BaseError, ContractFunctionRevertedError, type Abi, type Address, type WalletClient } from "viem";
import { relayTxs } from "../db/schema";
import type { Deps } from "./deps";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

export interface SendResult {
  ok: boolean;
  hash?: `0x${string}`;
  error?: string;
  /** Shadow mode: the call was simulated and logged, nothing was sent. */
  shadow?: boolean;
  /** The simulation (eth_call) succeeded. Set in shadow mode and on the send path. */
  simulated?: boolean;
}

export const GAS_HEADROOM_NUM = 13n; // gas limit = estimate x 1.3
export const GAS_HEADROOM_DEN = 10n;
export const FEE_CAP_NUM = 3n; //       max fee per gas = current gas price x 1.5
export const FEE_CAP_DEN = 2n;

interface Lane {
  running: boolean;
  high: Array<() => void>;
  low: Array<() => void>;
}
const lanes = new Map<string, Lane>();
/**
 * Runs `fn` after every earlier job for the same key finished (success or not), one at a time (one nonce stream per
 * account). `high` jobs (user claims) are picked before any waiting `low` job, so a flood of other relays can delay a
 * claim by at most the one send in flight.
 */
export function serialised<T>(key: string, fn: () => Promise<T>, priority: "high" | "low" = "low"): Promise<T> {
  const lane = lanes.get(key) ?? { running: false, high: [], low: [] };
  lanes.set(key, lane);
  return new Promise<T>((resolve, reject) => {
    const run = () => {
      lane.running = true;
      fn().then(resolve, reject).finally(() => {
        const next = lane.high.shift() ?? lane.low.shift();
        if (next) next();
        else {
          lane.running = false;
          lanes.delete(key);
        }
      });
    };
    if (!lane.running) run();
    else (priority === "high" ? lane.high : lane.low).push(run);
  });
}

/** Simulate a call from the wallet's account without sending (eth_call). */
export async function simulate(deps: Deps, wallet: WalletClient | undefined, call: ContractCall): Promise<{ ok: boolean; error?: string; request?: unknown }> {
  if (!wallet?.account) return { ok: false, error: "hot key not configured" };
  try {
    const { request } = await deps.clients.publicClient.simulateContract({ ...call, account: wallet.account } as never);
    return { ok: true, request };
  } catch (e) {
    return { ok: false, error: shortError(e) };
  }
}

/** Simulate first (no gas burned on calls that would revert), then send and wait. Every attempt is logged. */
export async function sendCall(
  deps: Deps,
  wallet: WalletClient | undefined,
  call: ContractCall,
  meta: { kind: string; escrowId?: string; questionId?: string; ipHash?: string; priority?: "high" | "low" },
): Promise<SendResult> {
  if (!wallet?.account) return { ok: false, error: "hot key not configured" };
  const account = wallet.account;
  return serialised(account.address.toLowerCase(), async () => {
    const sim = await simulate(deps, wallet, call);
    if (!sim.ok) {
      await deps.db.insert(relayTxs).values({ kind: meta.kind, escrowId: meta.escrowId, questionId: meta.questionId, ipHash: meta.ipHash, status: "skipped", error: sim.error });
      return { ok: false, error: sim.error, simulated: false };
    }
    try {
      const gas = await deps.clients.publicClient.estimateContractGas({ ...call, account } as never);
      const gasPrice = await deps.clients.publicClient.getGasPrice();
      const hash = await wallet.writeContract({
        ...(sim.request as object),
        gas: (gas * GAS_HEADROOM_NUM) / GAS_HEADROOM_DEN,
        maxFeePerGas: (gasPrice * FEE_CAP_NUM) / FEE_CAP_DEN,
        maxPriorityFeePerGas: 0n,
      } as never);
      await deps.db.insert(relayTxs).values({ kind: meta.kind, escrowId: meta.escrowId, questionId: meta.questionId, ipHash: meta.ipHash, txHash: hash, status: "sent" });
      const rcpt = await deps.clients.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
      const ok = rcpt.status === "success";
      deps.log(`${meta.kind} ${ok ? "mined" : "reverted"}`, { hash, escrowId: meta.escrowId, questionId: meta.questionId });
      return { ok, hash, simulated: true };
    } catch (e) {
      const error = shortError(e);
      await deps.db.insert(relayTxs).values({ kind: meta.kind, escrowId: meta.escrowId, questionId: meta.questionId, ipHash: meta.ipHash, status: "skipped", error });
      return { ok: false, error, simulated: true };
    }
  }, meta.priority ?? (meta.kind === "claim" ? "high" : "low"));
}

/** KEEPER_SHADOW=1: log what would be sent next to the eth_call answer, send nothing. */
export const isShadow = (deps: Deps) => deps.env.KEEPER_SHADOW === "1";

export async function shadowCall(
  deps: Deps,
  wallet: WalletClient | undefined,
  call: ContractCall,
  meta: { kind: string; escrowId?: string },
  decision: Record<string, unknown>,
): Promise<SendResult> {
  const sim = await simulate(deps, wallet, call);
  deps.log("shadow", { kind: meta.kind, escrowId: meta.escrowId, decision, ethCall: sim.ok ? "ok" : "revert", error: sim.error });
  return { ok: false, shadow: true, simulated: sim.ok, error: sim.error };
}

export function shortError(e: unknown): string {
  const m = e as { shortMessage?: string; message?: string };
  // the contract reverts NoChange for a relayed call that would change nothing (a repeat OK, the same refund addresses):
  // that is a refusal for the caller, said plainly, and it never costs gas (it fails in the simulation)
  if (/\bNoChange\b/.test(`${m.shortMessage ?? ""} ${m.message ?? ""}`)) return "this would not change anything, so it was not sent";
  // testnet run 2026-11-01: viem's shortMessage is only 'The contract function "x" reverted.'; the decoded custom error
  // (the RPC returns its data) is the reason the person needs, so it goes out in plain words or at least by name
  const reverted = e instanceof BaseError ? (e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null) : null;
  const name = reverted?.data?.errorName;
  if (name) return PLAIN_REVERTS[name] ?? `${(m.shortMessage ?? "the call would fail").replace(/\.$/, "")}: ${name}`.slice(0, 300);
  return (m.shortMessage ?? m.message ?? String(e)).slice(0, 300);
}

/** The escrow's refusals a person can act on, said plainly (copy rules: app/test/bannedWords.test.ts). */
const PLAIN_REVERTS: Record<string, string> = {
  CreationIsPaused: "new payments and challenge accepts are paused right now; claims, decisions and refunds keep working",
  AmountAboveCap: "the amount is above the current limit for one payment",
  AlreadyExists: "this payment already exists",
  NotOpen: "this payment is already finished",
  Expired: "this payment has expired",
  NotExpired: "this payment has not reached its expiry yet",
  AlreadyClaimed: "this link was already claimed",
  AlreadyAccepted: "this challenge was already accepted",
  AcceptWindowClosed: "the time to accept this challenge has passed",
  NotCancellable: "this payment cannot be cancelled",
  SignatureExpired: "the signature has expired, please sign again",
};

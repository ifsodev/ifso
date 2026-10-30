import type { Abi, Address, WalletClient } from "viem";
import { relayTxs } from "../db/schema";
import type { Deps } from "./deps";

export interface ContractCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
  value?: bigint;
}

/** Simulate first (no gas burned on calls that would revert), then send and wait. Every attempt is logged. */
export async function sendCall(
  deps: Deps,
  wallet: WalletClient | undefined,
  call: ContractCall,
  meta: { kind: string; escrowId?: string; questionId?: string; ipHash?: string },
): Promise<{ ok: boolean; hash?: `0x${string}`; error?: string }> {
  if (!wallet?.account) return { ok: false, error: "hot key not configured" };
  try {
    const { request } = await deps.clients.publicClient.simulateContract({ ...call, account: wallet.account } as never);
    const hash = await wallet.writeContract(request as never);
    await deps.db.insert(relayTxs).values({ kind: meta.kind, escrowId: meta.escrowId, questionId: meta.questionId, ipHash: meta.ipHash, txHash: hash, status: "sent" });
    const rcpt = await deps.clients.publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 });
    const ok = rcpt.status === "success";
    deps.log(`${meta.kind} ${ok ? "mined" : "reverted"}`, { hash, escrowId: meta.escrowId, questionId: meta.questionId });
    return { ok, hash };
  } catch (e) {
    const error = shortError(e);
    await deps.db.insert(relayTxs).values({ kind: meta.kind, escrowId: meta.escrowId, questionId: meta.questionId, ipHash: meta.ipHash, status: "skipped", error });
    return { ok: false, error };
  }
}

export function shortError(e: unknown): string {
  const m = e as { shortMessage?: string; message?: string };
  return (m.shortMessage ?? m.message ?? String(e)).slice(0, 300);
}

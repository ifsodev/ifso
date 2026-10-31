// Admin-event monitor. Watches the owner and admin events of the four contracts and tells the ops chat in plain words what
// changed, so a move by a signer (or by a stolen signer key) is seen within a minute. It only reads: it holds no key.
// Starts at the chain head the first time it runs (history before that was already reviewed at deploy), then follows a cursor
// kept in the `cursors` table. One alert per log (cause = tx hash + log index), so two changes in one block are two messages.
import { eq } from "drizzle-orm";
import { decodeEventLog, formatUnits, type Abi, type AbiEvent, type Address, type Log } from "viem";
import { feeRouterAbi, ifsoConditionEvaluatorAbi, ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../abi";
import { getLogsChunked } from "../chain/rpc";
import { cursors } from "../db/schema";
import { raise, type Deps } from "./deps";

const CURSOR = "admin-watch";
const MAX_SPAN = 20_000n; // blocks read in one tick; a long outage is caught up over several ticks

export type ContractLabel = "escrow" | "conditions" | "questions" | "fee router";

/** Admin events per contract: the whole list the owner or panel can change. */
export const ADMIN_EVENTS: Record<ContractLabel, readonly string[]> = {
  escrow: ["OwnershipTransferStarted", "OwnershipTransferred", "FeesUpdated", "CreationPaused", "MaxAmountUpdated"],
  conditions: ["OwnershipTransferStarted", "OwnershipTransferred", "FeedSet", "PythIdSet", "ResolverSet"],
  questions: ["OwnershipTransferStarted", "OwnershipTransferred", "CreatorSet", "BondAmountSet", "PanelChangeQueued", "PanelChanged"],
  "fee router": ["OwnershipTransferStarted", "OwnershipTransferred", "RecipientsSet", "Swept"],
};

const ABIS: Record<ContractLabel, Abi> = {
  escrow: ifsoEscrowAbi as Abi,
  conditions: ifsoConditionEvaluatorAbi as Abi,
  questions: ifsoOutcomeResolverAbi as Abi,
  "fee router": feeRouterAbi as Abi,
};

const usdg = (v: unknown) => `${formatUnits(BigInt(v as bigint), 6)} USDG`;
const who = (a: unknown) => String(a);
const onOff = (b: unknown, on: string, off: string) => (b ? on : off);

/** Plain-words line for one admin event. Pure, so every wording is unit-tested. */
export function describeAdminEvent(contract: ContractLabel, name: string, a: Record<string, unknown>): string {
  switch (name) {
    case "OwnershipTransferStarted":
      return `Ownership of the ${contract} contract is being handed from ${who(a.previousOwner)} to ${who(a.newOwner)}. Nothing changes until the new address accepts. If nobody planned this, treat it as an incident.`;
    case "OwnershipTransferred":
      return `The ${contract} contract is now owned by ${who(a.newOwner)} (it was ${who(a.previousOwner)}). If this was not planned, treat it as an incident.`;
    case "FeesUpdated":
      return `Fees changed: creation fee ${usdg(a.creationFee)}, resolver fee ${usdg(a.resolverFee)}. New payments pay these amounts.`;
    case "CreationPaused":
      return onOff(a.paused, "New payments are now PAUSED. Claims, settlement and refunds keep working.", "New payments are open again (the pause was lifted).");
    case "MaxAmountUpdated":
      return BigInt(a.maxAmount as bigint) === 0n ? "The launch cap on payment size was REMOVED." : `The launch cap on payment size is now ${usdg(a.maxAmount)}.`;
    case "FeedSet":
      return `Price feed ${who(a.feed)} (stock token ${who(a.stockToken)}) was ${onOff(a.allowed, "ALLOWED", "removed")} for new payments.`;
    case "PythIdSet":
      return `Pyth price id ${who(a.priceId)} (stock token ${who(a.stockToken)}) was ${onOff(a.allowed, "ALLOWED", "removed")} for new payments.`;
    case "ResolverSet":
      return `Question contract ${who(a.resolver)} was ${onOff(a.allowed, "ALLOWED", "removed")} as a source of outcomes.`;
    case "CreatorSet":
      return `Service key ${who(a.creator)} was ${onOff(a.allowed, "ALLOWED", "removed")} as a question creator.`;
    case "BondAmountSet":
      return `The bond for proposals and disputes is now ${usdg(a.bondAmount)}.`;
    case "PanelChangeQueued":
      return `A new decision panel ${who(a.panel)} was queued. It takes effect after the 48 hour delay (at unix time ${String(a.executableAt)}). Cancel it before then if it is wrong.`;
    case "PanelChanged":
      return `The decision panel is now ${who(a.panel)}.`;
    case "RecipientsSet":
      return `Fee recipients changed: work ${who(a.work)}, treasury ${who(a.treasury)}, perks ${who(a.perks)}, burn ${who(a.burn)}.`;
    case "Swept":
      return `${usdg(a.amount)} of token ${who(a.token)} was swept from the fee router to ${who(a.to)}.`;
    default:
      return `Admin event ${name} on the ${contract} contract.`;
  }
}

function watched(deps: Deps): { label: ContractLabel; address: Address }[] {
  const c = deps.clients;
  const list: [ContractLabel, Address | undefined][] = [
    ["escrow", c.escrow],
    ["conditions", c.evaluator],
    ["questions", c.resolverContract],
    ["fee router", c.feeRouter],
  ];
  return list.filter((x): x is [ContractLabel, Address] => !!x[1]).map(([label, address]) => ({ label, address }));
}

async function loadCursor(deps: Deps): Promise<bigint | undefined> {
  const [row] = await deps.db.select().from(cursors).where(eq(cursors.name, CURSOR));
  return row?.block;
}
async function saveCursor(deps: Deps, block: bigint) {
  await deps.db.insert(cursors).values({ name: CURSOR, block }).onConflictDoUpdate({ target: cursors.name, set: { block } });
}

/** One pass. Returns the number of alerts raised. */
export async function adminWatchTick(deps: Deps): Promise<number> {
  const contracts = watched(deps);
  if (!contracts.length) return 0;
  const pc = deps.clients.publicClient;
  const head = (await pc.getBlockNumber({ cacheTime: 0 })) - deps.env.CONFIRMATIONS;
  const last = await loadCursor(deps);
  if (last === undefined) {
    await saveCursor(deps, head); // first run: watch from now on
    return 0;
  }
  const from = last + 1n;
  if (from > head) return 0;
  const to = head - from + 1n > MAX_SPAN ? from + MAX_SPAN - 1n : head;
  let raised = 0;
  for (const { label, address } of contracts) {
    const abi = ABIS[label];
    const events = abi.filter((i): i is AbiEvent => i.type === "event" && ADMIN_EVENTS[label].includes(i.name));
    const logs = (await getLogsChunked(pc, { address, events, fromBlock: from, toBlock: to })) as Log[];
    for (const log of logs) {
      let decoded: { eventName?: string; args?: unknown };
      try {
        decoded = decodeEventLog({ abi, data: log.data, topics: log.topics }) as { eventName?: string; args?: unknown };
      } catch {
        continue;
      }
      if (!decoded.eventName || !ADMIN_EVENTS[label].includes(decoded.eventName)) continue;
      const text = describeAdminEvent(label, decoded.eventName, (decoded.args ?? {}) as Record<string, unknown>);
      await raise(deps, `admin-${log.transactionHash}-${log.logIndex}`, `${text} (contract ${address}, tx ${log.transactionHash}, block ${log.blockNumber})`);
      raised++;
    }
  }
  await saveCursor(deps, to);
  return raised;
}

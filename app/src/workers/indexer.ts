// Indexer: polls IfsoEscrow + IfsoOutcomeResolver logs from a cursor and mirrors state into Postgres, then
// fans events out to the notifier. RHC makes ~10 blocks/s, so ranges are chunked. Reorg depth on an Orbit
// chain is ~0 for soft-confirmed blocks, but we still trail the head by CONFIRMATIONS.
import { eq } from "drizzle-orm";
import type { Address, Hex, Log } from "viem";
import { decodeEventLog } from "viem";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../abi";
import { Kind, Status } from "../core/types";
import { chainEvents, cursors, escrows, questions } from "../db/schema";
import type { Deps } from "./deps";

const CHUNK = 20_000n;
const CONFIRMATIONS = 20n;

type Notify = (event: { name: string; escrowId?: string; questionId?: string; args: Record<string, unknown>; txHash: Hex }) => Promise<void>;

export async function indexerTick(deps: Deps, notify: Notify) {
  const escrow = deps.clients.escrow;
  const resolver = deps.clients.resolverContract;
  if (!escrow) return;
  const head = (await deps.clients.publicClient.getBlockNumber()) - CONFIRMATIONS;
  const [cur] = await deps.db.select().from(cursors).where(eq(cursors.name, "main"));
  let from = cur ? cur.block + 1n : deps.env.ESCROW_DEPLOY_BLOCK;
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const logs = await deps.clients.publicClient.getLogs({ address: [escrow, ...(resolver ? [resolver] : [])] as Address[], fromBlock: from, toBlock: to });
    for (const log of logs) await handleLog(deps, log, escrow, notify);
    await deps.db.insert(cursors).values({ name: "main", block: to }).onConflictDoUpdate({ target: cursors.name, set: { block: to } });
    from = to + 1n;
  }
}

async function handleLog(deps: Deps, log: Log, escrow: Address, notify: Notify) {
  const isEscrow = log.address.toLowerCase() === escrow.toLowerCase();
  let decoded: { eventName: string; args: Record<string, unknown> };
  try {
    decoded = decodeEventLog({ abi: isEscrow ? ifsoEscrowAbi : ifsoOutcomeResolverAbi, data: log.data, topics: log.topics }) as never;
  } catch {
    return;
  }
  const args = decoded.args;
  const escrowId = isEscrow && args.id !== undefined ? String(args.id) : undefined;
  const questionId = !isEscrow && args.questionId ? String(args.questionId) : undefined;
  await deps.db
    .insert(chainEvents)
    .values({ blockNumber: log.blockNumber!, logIndex: log.logIndex!, txHash: log.transactionHash!, address: log.address, name: decoded.eventName, args: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), escrowId })
    .onConflictDoNothing();

  if (isEscrow && escrowId) await applyEscrowEvent(deps, decoded.eventName, escrowId, args, log, escrow);
  if (!isEscrow && questionId) await applyResolverEvent(deps, decoded.eventName, questionId, args);
  await notify({ name: decoded.eventName, escrowId, questionId, args, txHash: log.transactionHash! });
}

const STATUS_BY_EVENT: Record<string, Status> = {
  Met: Status.MET,
  Released: Status.RELEASED,
  Returned: Status.RETURNED,
  Voided: Status.VOIDED,
  Cancelled: Status.CANCELLED,
};

async function applyEscrowEvent(deps: Deps, name: string, id: string, args: Record<string, unknown>, log: Log, escrow: Address) {
  if (name === "Created") {
    const [e, c] = await Promise.all([
      deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [BigInt(id)] }),
      deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getCondition", args: [BigInt(id)] }),
    ]);
    const cond = JSON.parse(JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    await deps.db
      .insert(escrows)
      .values({
        id,
        sender: e.sender.toLowerCase(),
        recipient: e.recipient === "0x0000000000000000000000000000000000000000" ? null : e.recipient.toLowerCase(),
        linkKey: e.linkKey === "0x0000000000000000000000000000000000000000" ? null : e.linkKey.toLowerCase(),
        amount: e.amount.toString(),
        counterAmount: e.counterAmount.toString(),
        kind: Number(c.kind),
        condition: cond,
        conditionHash: e.conditionHash,
        feed: Number(c.kind) === Kind.PRICE && c.target !== "0x0000000000000000000000000000000000000000" ? c.target : null,
        questionId: Number(c.kind) === Kind.OUTCOME ? c.key : null,
        deadline: c.deadline > 0n ? new Date(Number(c.deadline) * 1000) : null,
        expiry: new Date(Number(e.expiry) * 1000),
        acceptBy: e.acceptBy > 0n ? new Date(Number(e.acceptBy) * 1000) : null,
        twoSided: Boolean(args.twoSided),
        activeFrom: new Date(Number(e.activeFrom) * 1000),
        altRefundTo: e.altRefundTo,
        status: Status.OPEN,
        createdBlock: log.blockNumber!,
        createdTx: log.transactionHash!,
        feePaid: String(args.feePaid ?? 0),
      })
      .onConflictDoNothing();
    return;
  }
  if (name === "Claimed") {
    await deps.db.update(escrows).set({ recipient: String(args.recipient).toLowerCase(), updatedAt: new Date() }).where(eq(escrows.id, id));
  } else if (name === "Accepted") {
    const e = await deps.clients.publicClient.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [BigInt(id)] });
    await deps.db.update(escrows).set({ recipient: String(args.acceptor).toLowerCase(), accepted: true, activeFrom: new Date(Number(e.activeFrom) * 1000), updatedAt: new Date() }).where(eq(escrows.id, id));
  } else if (name === "RefundAddressesChanged") {
    await deps.db.update(escrows).set({ altRefundTo: String(args.altRefundTo), updatedAt: new Date() }).where(eq(escrows.id, id));
  } else if (STATUS_BY_EVENT[name] !== undefined) {
    await deps.db.update(escrows).set({ status: STATUS_BY_EVENT[name]!, updatedAt: new Date() }).where(eq(escrows.id, id));
  }
}

async function applyResolverEvent(deps: Deps, name: string, qid: string, args: Record<string, unknown>) {
  if (name === "Proposed") await deps.db.update(questions).set({ state: 2, proposedOutcome: Number(args.outcome), proposer: String(args.proposer) }).where(eq(questions.id, qid));
  else if (name === "Disputed") await deps.db.update(questions).set({ state: 3 }).where(eq(questions.id, qid));
  else if (name === "Finalized") await deps.db.update(questions).set({ state: 4, finalOutcome: Number(args.outcome) }).where(eq(questions.id, qid));
  else if (name === "PanelTimedOut") await deps.db.update(questions).set({ state: 5 }).where(eq(questions.id, qid));
}

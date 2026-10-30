// Indexer: polls IfsoEscrow + IfsoOutcomeResolver logs from a cursor and mirrors state into Postgres, then
// fans events out to the notifier.
//
// - Trails the head by CONFIRMATIONS blocks (default 3) and reads logs with getLogsChunked (public-RPC friendly).
// - The cursor stores the block NUMBER and HASH. Every tick first checks that the cursor block still has that hash;
//   a mismatch means a reorg, so it rewinds REWIND_BLOCKS (50), drops the rows that came from the dead blocks,
//   re-reads the affected escrows and questions from the chain, and replays. Events and their state change are
//   written in one transaction, so a crash never leaves one without the other; a restart resumes at the cursor.
import { eq, gt } from "drizzle-orm";
import type { Address, Hex, Log } from "viem";
import { decodeEventLog } from "viem";
import { ifsoEscrowAbi, ifsoOutcomeResolverAbi } from "../abi";
import { Kind, Status } from "../core/types";
import { getLogsChunked } from "../chain/rpc";
import { chainEvents, cursors, escrows, questions } from "../db/schema";
import { raise, type Deps } from "./deps";

const CHUNK = 5_000n;
export const REWIND_BLOCKS = 50n;
const CURSOR = "main";
const F_ACCEPTED = 2;

export type NotifyEvent = { name: string; escrowId?: string; questionId?: string; args: Record<string, unknown>; txHash: Hex };
type Notify = (event: NotifyEvent) => Promise<void>;

/** Events dropped by a rewind, so replaying the same transaction in a new block does not notify twice. */
const droppedKeys = new Set<string>();
const eventKey = (tx: string, name: string, id?: string) => `${tx}:${name}:${id ?? ""}`;
export const resetIndexerState = () => droppedKeys.clear();

export async function indexerTick(deps: Deps, notify: Notify, opts: { confirmations?: bigint } = {}) {
  const escrow = deps.clients.escrow;
  const resolver = deps.clients.resolverContract;
  if (!escrow) return;
  const pc = deps.clients.publicClient;
  const confirmations = opts.confirmations ?? deps.env.CONFIRMATIONS;
  const tip = await pc.getBlockNumber();
  const head = tip - confirmations;

  let cur = await loadCursor(deps);
  if (cur && !(await cursorIsCanonical(deps, cur))) {
    deps.log("reorg detected at the cursor: rewinding", { cursor: cur.block, rewind: REWIND_BLOCKS });
    await raise(deps, "indexer-reorg", `chain reorganised at block ${cur.block}; the indexer rewound ${REWIND_BLOCKS} blocks and is replaying`);
    cur = await rewind(deps, cur.block);
  }
  let from = cur ? cur.block + 1n : deps.env.ESCROW_DEPLOY_BLOCK;
  const addresses = [escrow, ...(resolver ? [resolver] : [])] as Address[];
  while (from <= head) {
    const to = from + CHUNK - 1n > head ? head : from + CHUNK - 1n;
    const before = (await pc.getBlock({ blockNumber: to })).hash;
    const logs = (await getLogsChunked(pc, { address: addresses, fromBlock: from, toBlock: to })) as Log[];
    const after = (await pc.getBlock({ blockNumber: to })).hash;
    if (before !== after) return; // reorganised while reading: try again on the next tick
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? Number(a.logIndex) - Number(b.logIndex) : a.blockNumber! < b.blockNumber! ? -1 : 1));
    for (const log of logs) await handleLog(deps, log, escrow, notify);
    await saveCursor(deps, to, before);
    from = to + 1n;
  }
}

async function loadCursor(deps: Deps) {
  const [row] = await deps.db.select().from(cursors).where(eq(cursors.name, CURSOR));
  return row ? { block: row.block, hash: row.hash } : undefined;
}

async function saveCursor(deps: Deps, block: bigint, hash: Hex) {
  await deps.db.insert(cursors).values({ name: CURSOR, block, hash }).onConflictDoUpdate({ target: cursors.name, set: { block, hash } });
}

async function cursorIsCanonical(deps: Deps, cur: { block: bigint; hash: string | null }): Promise<boolean> {
  try {
    const b = await deps.clients.publicClient.getBlock({ blockNumber: cur.block });
    if (cur.hash === null) {
      await saveCursor(deps, cur.block, b.hash); // cursor written before hashes were kept: adopt the chain's
      return true;
    }
    return b.hash === cur.hash;
  } catch {
    return false; // the block is gone (the chain got shorter)
  }
}

/** Drop what the dead blocks produced, repair the rows they touched from the chain, and move the cursor back. */
async function rewind(deps: Deps, cursorBlock: bigint): Promise<{ block: bigint; hash: string | null } | undefined> {
  const escrow = deps.clients.escrow!;
  const resolver = deps.clients.resolverContract;
  const pc = deps.clients.publicClient;
  let target = cursorBlock - REWIND_BLOCKS;
  if (target < deps.env.ESCROW_DEPLOY_BLOCK) target = deps.env.ESCROW_DEPLOY_BLOCK - 1n;

  const dead = await deps.db.select().from(chainEvents).where(gt(chainEvents.blockNumber, target));
  const touchedEscrows = new Set<string>();
  const touchedQuestions = new Set<string>();
  for (const ev of dead) {
    droppedKeys.add(eventKey(ev.txHash, ev.name, ev.escrowId ?? (ev.args as { questionId?: string }).questionId));
    if (ev.escrowId) touchedEscrows.add(ev.escrowId);
    const q = (ev.args as { questionId?: string }).questionId;
    if (q && !ev.escrowId) touchedQuestions.add(q);
  }
  if (droppedKeys.size > 50_000) droppedKeys.clear();

  await deps.db.transaction(async (tx) => {
    await tx.delete(chainEvents).where(gt(chainEvents.blockNumber, target));
    await tx.delete(escrows).where(gt(escrows.createdBlock, target));
    for (const id of touchedEscrows) {
      const e = await pc.readContract({ address: escrow, abi: ifsoEscrowAbi, functionName: "getEscrow", args: [BigInt(id)] });
      if (e.status === Status.NONE) {
        await tx.delete(escrows).where(eq(escrows.id, id)); // the escrow only existed on the dead fork
        continue;
      }
      await tx
        .update(escrows)
        .set({
          status: e.status,
          recipient: e.recipient === "0x0000000000000000000000000000000000000000" ? null : e.recipient.toLowerCase(),
          accepted: (e.flags & F_ACCEPTED) !== 0,
          altRefundTo: e.altRefundTo,
          activeFrom: new Date(Number(e.activeFrom) * 1000),
          updatedAt: new Date(),
        })
        .where(eq(escrows.id, id));
    }
    if (resolver) {
      for (const qid of touchedQuestions) {
        const q = await pc.readContract({ address: resolver, abi: ifsoOutcomeResolverAbi, functionName: "getQuestion", args: [qid as Hex] });
        const state = Number(q.state);
        await tx
          .update(questions)
          .set({
            state,
            proposer: state >= 2 ? q.proposer : null,
            proposedOutcome: state >= 2 ? Number(q.proposed) : null,
            finalOutcome: state === 4 ? Number(q.finalOutcome) : null,
          })
          .where(eq(questions.id, qid));
      }
    }
  });

  if (target < deps.env.ESCROW_DEPLOY_BLOCK) {
    await deps.db.delete(cursors).where(eq(cursors.name, CURSOR));
    return undefined;
  }
  try {
    const b = await pc.getBlock({ blockNumber: target });
    await saveCursor(deps, target, b.hash);
    return { block: target, hash: b.hash };
  } catch {
    await deps.db.delete(cursors).where(eq(cursors.name, CURSOR)); // chain shorter than the rewind point: start over
    return undefined;
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
  const fresh = await deps.db.transaction(async (tx) => {
    const t = { ...deps, db: tx as unknown as Deps["db"] };
    const inserted = await tx
      .insert(chainEvents)
      .values({ blockNumber: log.blockNumber!, logIndex: log.logIndex!, txHash: log.transactionHash!, address: log.address, name: decoded.eventName, args: JSON.parse(JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? v.toString() : v))), escrowId })
      .onConflictDoNothing()
      .returning({ b: chainEvents.blockNumber });
    if (!inserted.length) return false; // already stored with its state change (same transaction)
    if (isEscrow && escrowId) await applyEscrowEvent(t, decoded.eventName, escrowId, args, log, escrow);
    if (!isEscrow && questionId) await applyResolverEvent(t, decoded.eventName, questionId, args);
    return true;
  });
  if (!fresh) return;
  const key = eventKey(log.transactionHash!, decoded.eventName, escrowId ?? questionId);
  if (droppedKeys.delete(key)) return; // replay of an event already announced before a reorg
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

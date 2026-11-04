// OUTCOME payments that the keeper set aside because their question was not final yet (audit M-3 / L-4: 2 min doubling
// to 30 min, so no RPC reads or gas are spent on open questions). When a question is seen FINAL or VOID (the indexer's
// Finalized / PanelTimedOut event, or the resolver's own finalize), its payments are released from that wait so they
// settle on the next keeper tick instead of up to 30 minutes later. In memory, like the keeper's back-off: the worker
// role runs the keeper, the indexer and the resolver in one process, and a restart retries every row anyway.
const waiting = new Map<string, Set<string>>(); // questionId -> escrow ids waiting on it
const released = new Set<string>(); // escrow ids whose wait was cleared, picked up by the keeper's next pass

const norm = (q: string) => q.toLowerCase();

export function noteOutcomeWait(questionId: string, escrowId: string) {
  const k = norm(questionId);
  let s = waiting.get(k);
  if (!s) waiting.set(k, (s = new Set()));
  s.add(escrowId);
}

/** Called when `questionId` is seen FINAL or VOID. */
export function questionSettled(questionId: string) {
  const s = waiting.get(norm(questionId));
  if (!s) return;
  for (const id of s) released.add(id);
  waiting.delete(norm(questionId));
}

/** Escrow ids released since the last call (the keeper clears their wait back-off). */
export function takeReleased(): string[] {
  const out = [...released];
  released.clear();
  return out;
}

export const resetOutcomeWaits = () => (waiting.clear(), released.clear());

// Real-user counter: pure function over decoded IfsoEscrow events (Created / Accepted / Claimed). The same function
// serves GET /stats/users (events from the indexer table) and scripts/user-count.ts (events read from the chain), so
// the two cannot disagree on the rules:
//  - addresses on the internal list (our relayer, keeper, resolver, deployer, test wallets) never count anywhere;
//    an escrow created by one is left out of "escrows" and "volume" too
//  - unique senders = Created.sender; unique recipients (bound) = Created.recipient when set, Claimed.recipient,
//    and the acceptor of a challenge; unique acceptors = Accepted.acceptor
//  - volume = Created.amount, plus the challenge side (counterAmount) once it was accepted; raw 6-decimal USDG
//  - per day = UTC day of the block time; uniques are per day
export interface StatEvent {
  name: string;
  /** block timestamp in seconds, null when unknown */
  blockTime: number | null;
  args: Record<string, unknown>;
}

export interface DayStats {
  day: string;
  uniqueSenders: number;
  uniqueRecipients: number;
  uniqueAcceptors: number;
  escrowsCreated: number;
  volumeUsdg: string;
}
export interface UserStats extends Omit<DayStats, "day"> {
  since: string | null;
  perDay: DayStats[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (v: unknown) => String(v ?? "").toLowerCase();
const dayOf = (sec: number) => new Date(sec * 1000).toISOString().slice(0, 10);

interface Bucket {
  senders: Set<string>;
  recipients: Set<string>;
  acceptors: Set<string>;
  created: number;
  volume: bigint;
}
const bucket = (): Bucket => ({ senders: new Set(), recipients: new Set(), acceptors: new Set(), created: 0, volume: 0n });
const toStats = (b: Bucket) => ({ uniqueSenders: b.senders.size, uniqueRecipients: b.recipients.size, uniqueAcceptors: b.acceptors.size, escrowsCreated: b.created, volumeUsdg: b.volume.toString() });

/** `sinceSec`: only events at or after this time (events with an unknown time are then skipped). */
export function computeUserStats(events: StatEvent[], internal: Iterable<string>, sinceSec?: number): UserStats {
  const skip = new Set([...internal].map((a) => a.toLowerCase()));
  const total = bucket();
  const days = new Map<string, Bucket>();
  const inScope = (e: StatEvent) => sinceSec === undefined || (e.blockTime !== null && e.blockTime >= sinceSec);
  const touch = (e: StatEvent, f: (b: Bucket) => void) => {
    f(total);
    if (e.blockTime === null) return;
    const d = dayOf(e.blockTime);
    let b = days.get(d);
    if (!b) days.set(d, (b = bucket()));
    f(b);
  };
  // Created first (an Accepted needs its escrow's counter amount, whatever the order of the input)
  const created = new Map<string, { counter: bigint; excluded: boolean }>();
  for (const e of events) {
    if (e.name !== "Created") continue;
    const id = String(e.args.id);
    if (created.has(id)) continue; // the same log read twice
    const sender = lc(e.args.sender);
    const excluded = skip.has(sender);
    created.set(id, { counter: BigInt(String(e.args.counterAmount ?? 0)), excluded });
    if (!inScope(e) || excluded) continue;
    const recipient = lc(e.args.recipient);
    touch(e, (b) => {
      b.senders.add(sender);
      b.created += 1;
      b.volume += BigInt(String(e.args.amount ?? 0));
      if (recipient && recipient !== ZERO && !skip.has(recipient)) b.recipients.add(recipient);
    });
  }
  const seenAccept = new Set<string>();
  for (const e of events) {
    if (!inScope(e)) continue;
    if (e.name === "Claimed") {
      const r = lc(e.args.recipient);
      if (r && r !== ZERO && !skip.has(r)) touch(e, (b) => b.recipients.add(r));
    } else if (e.name === "Accepted") {
      const id = String(e.args.id);
      if (seenAccept.has(id)) continue;
      seenAccept.add(id);
      const a = lc(e.args.acceptor);
      if (!a || skip.has(a)) continue;
      const esc = created.get(id);
      touch(e, (b) => {
        b.acceptors.add(a);
        b.recipients.add(a);
        if (esc && !esc.excluded) b.volume += esc.counter;
      });
    }
  }
  return {
    since: sinceSec === undefined ? null : new Date(sinceSec * 1000).toISOString(),
    ...toStats(total),
    perDay: [...days.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([day, b]) => ({ day, ...toStats(b) })),
  };
}

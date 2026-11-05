// Draft (from the parser or the web form) -> on-chain CreateParams with studio defaults.
import { toHex, type Address, type Hex } from "viem";
import type { ConditionDraft } from "./parser";
import { binaryMask, sportsMask } from "./outcome";
import { underlyingToFeedUnits } from "./condition";
import { parseUsdg } from "./money";
import {
  APPROVE_PARTIES,
  APPROVE_REFEREE,
  Kind,
  OP_GTE,
  OP_LTE,
  PRICE_AT_DEADLINE,
  PRICE_TOUCH,
  SRC_CHAINLINK,
  ZERO_ADDRESS,
  emptyCondition,
  type Condition,
  type CreateParams,
} from "./types";

export const DEFAULTS = {
  maxStale: 25 * 3600, //       Chainlink equity heartbeat is 24 h; +1 h slack
  /**
   * Freshness for a CHALLENGE on a price at the deadline. The contract requires acceptBy + maxStale < deadline, so the
   * 25 h used for one-sided payments would make every challenge shorter than a day impossible. One hour keeps the
   * price check strict (an older print falls back to the first print after the deadline, still on-chain and fair)
   * and lets a challenge on a deadline a little over 1 h 10 min away be built.
   */
  challengeMaxStale: 3600,
  holdWindow: 4 * 86400, //     the contract cap (HOLD_CAP): a holiday long weekend with a paused feed does not VOID (DECISIONS #46)
  timeClaimWindow: 7 * 86400,
  priceSettleWindow: 4 * 86400, // after deadline + hold
  touchGrace: 86400,
  outcomeWindow: 7 * 86400, //  after earliestResolve
  approveWindow: 30 * 86400,
  challengeAcceptWindow: 2 * 86400,
  /** A challenge must stay acceptable for at least this long, or the builder refuses it (contract: acceptBy > now). */
  challengeMinAcceptWindow: 10 * 60,
  /** Challenges on a league fixture close this long before kickoff. */
  sportsChallengeMargin: 10 * 60,
  /**
   * Challenges on a Polymarket market close this long before its creation-time endDate. Markets often become
   * knowable before endDate, so the margin keeps the acceptance window well clear of the likely answer.
   */
  polymarketChallengeMargin: 24 * 3600,
  /**
   * DECISIONS #33 (review R3-H1): a Polymarket question can be resolved no earlier than endDate + 24 h, after the
   * expected UMA settlement (2 h liveness plus margin), so an honest proposal normally meets final sources.
   */
  polymarketResolveDelay: 24 * 3600,
};

/** Thrown for a request the contract would reject; the API turns it into a plain 400. */
export class BuildError extends Error {}

export interface ResolvedOutcome {
  resolver: Address;
  questionId: Hex;
  earliestResolve: number;
  /** sports: is the user's team the home side; markets: undefined */
  teamIsHome?: boolean;
  /** question close time (kickoff / endDate). With `challengeMargin` it bounds `acceptBy` of a challenge. */
  closeTime?: number;
  challengeMargin?: number;
  /**
   * The evaluator's OUTCOME expiry minimum, in seconds after earliestResolve: PROPOSAL_GRACE + the resolver's
   * dispute and panel windows + MIN_CLAIM_WINDOW, read from the chain (see `outcomeMinSpan`). When set, the expiry
   * is never earlier than this; unset keeps the default window.
   */
  minSpan?: number;
}

export interface BuildInput {
  draft: ConditionDraft;
  nowSec: number;
  amountUsdg: string;
  counterAmountUsdg?: string;
  twoSided: boolean;
  recipient?: Address; // named recipient, or undefined for a link
  linkKey?: Address; //  derived client-side from the link secret
  referee?: Address;
  altRefundTo?: Address;
  refundTo?: Address;
  cancellable?: boolean;
  salt?: Hex;
  feed?: { feed: Address; stockToken?: Address; multiplier: bigint };
  outcome?: ResolvedOutcome;
  expiryOverride?: number;
}

export function randomSalt(): Hex {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return toHex(b);
}

export function buildCondition(input: BuildInput): { condition: Condition; expiry: number } {
  const d = input.draft;
  const c = emptyCondition();
  const now = input.nowSec;
  switch (d.kind) {
    case "TIME":
      c.kind = Kind.TIME;
      c.deadline = BigInt(d.at);
      return { condition: c, expiry: d.at + DEFAULTS.timeClaimWindow };
    case "PRICE": {
      if (!input.feed) throw new Error(`no feed registered for ${d.ticker}`);
      c.kind = Kind.PRICE;
      c.mode = d.mode === "TOUCH" ? PRICE_TOUCH : PRICE_AT_DEADLINE;
      c.op = d.op === "GTE" ? OP_GTE : OP_LTE;
      c.source = SRC_CHAINLINK;
      c.target = input.feed.feed;
      c.stockToken = input.feed.stockToken ?? ZERO_ADDRESS;
      c.multiplier = input.feed.stockToken ? input.feed.multiplier : 0n;
      // user typed the underlying share price; feed units = underlying x multiplier, applied ONCE here
      c.threshold = underlyingToFeedUnits(d.priceUsd, input.feed.stockToken ? input.feed.multiplier : 10n ** 18n);
      c.deadline = BigInt(d.deadline);
      if (d.mode === "TOUCH") {
        if (input.twoSided) throw new BuildError("A challenge can only check the price at the deadline. Use \"is at or above\" instead of \"hits\", or send a one-sided if-so payment.");
        c.start = BigInt(now);
        return { condition: c, expiry: d.deadline + DEFAULTS.touchGrace };
      }
      c.maxStale = input.twoSided ? DEFAULTS.challengeMaxStale : DEFAULTS.maxStale;
      c.holdWindow = DEFAULTS.holdWindow;
      return { condition: c, expiry: d.deadline + DEFAULTS.holdWindow + DEFAULTS.priceSettleWindow };
    }
    case "SPORTS":
    case "MARKET": {
      const o = input.outcome;
      if (!o) throw new Error("question not resolved for this condition");
      c.kind = Kind.OUTCOME;
      c.target = o.resolver;
      c.key = o.questionId;
      c.outcomeMask = d.kind === "SPORTS" ? sportsMask(!!o.teamIsHome, d.result) : binaryMask(d.answer);
      return { condition: c, expiry: o.earliestResolve + Math.max(DEFAULTS.outcomeWindow, o.minSpan ?? 0) };
    }
    case "APPROVE":
      c.kind = Kind.APPROVE;
      if (d.mode === "PARTIES") c.mode = APPROVE_PARTIES;
      else {
        if (!input.referee) throw new Error("referee address not resolved");
        c.mode = APPROVE_REFEREE;
        c.target = input.referee;
      }
      return { condition: c, expiry: now + DEFAULTS.approveWindow };
  }
}

/**
 * Latest acceptBy the contract takes for this condition, minus our margin, capped at the default window and one hour
 * before expiry. Refuses (BuildError) when less than the minimum window is left, instead of building a call that reverts.
 */
export function challengeAcceptBy(input: BuildInput, condition: Condition, expiry: number): number {
  const now = input.nowSec;
  let latest = Math.min(now + DEFAULTS.challengeAcceptWindow, expiry - 3600);
  if (condition.kind === Kind.PRICE) latest = Math.min(latest, Number(condition.deadline) - condition.maxStale - 1); // contract: acceptBy + maxStale < deadline
  if (condition.kind === Kind.OUTCOME && input.outcome?.closeTime !== undefined) {
    latest = Math.min(latest, input.outcome.closeTime - (input.outcome.challengeMargin ?? DEFAULTS.sportsChallengeMargin));
  }
  if (latest < now + DEFAULTS.challengeMinAcceptWindow) {
    throw new BuildError("This challenge would have to be accepted within minutes. Pick a later deadline or a later event.");
  }
  return latest;
}

export function buildParams(input: BuildInput): CreateParams {
  if (!!input.recipient === !!input.linkKey) throw new Error("exactly one of recipient / linkKey");
  const { condition, expiry } = buildCondition(input);
  return {
    amount: parseUsdg(input.amountUsdg),
    counterAmount: input.twoSided ? parseUsdg(input.counterAmountUsdg ?? input.amountUsdg) : 0n,
    recipient: input.recipient ?? ZERO_ADDRESS,
    linkKey: input.linkKey ?? ZERO_ADDRESS,
    refundTo: input.refundTo ?? ZERO_ADDRESS,
    altRefundTo: input.altRefundTo ?? ZERO_ADDRESS,
    expiry: BigInt(input.expiryOverride ?? expiry),
    acceptBy: input.twoSided ? BigInt(challengeAcceptBy(input, condition, input.expiryOverride ?? expiry)) : 0n,
    twoSided: input.twoSided,
    cancellable: input.twoSided ? false : !!input.cancellable,
    salt: input.salt ?? randomSalt(),
    condition,
  };
}

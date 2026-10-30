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
  holdWindow: 3 * 86400, //     covers a weekend (+ one holiday) if the feed paused
  timeClaimWindow: 7 * 86400,
  priceSettleWindow: 4 * 86400, // after deadline + hold
  touchGrace: 86400,
  outcomeWindow: 7 * 86400, //  after earliestResolve
  approveWindow: 30 * 86400,
  challengeAcceptWindow: 2 * 86400,
};

export interface ResolvedOutcome {
  resolver: Address;
  questionId: Hex;
  earliestResolve: number;
  /** sports: is the user's team the home side; markets: undefined */
  teamIsHome?: boolean;
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
        c.start = BigInt(now);
        return { condition: c, expiry: d.deadline + DEFAULTS.touchGrace };
      }
      c.maxStale = DEFAULTS.maxStale;
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
      return { condition: c, expiry: o.earliestResolve + DEFAULTS.outcomeWindow };
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
    acceptBy: input.twoSided ? BigInt(Math.min(input.nowSec + DEFAULTS.challengeAcceptWindow, expiry - 3600)) : 0n,
    twoSided: input.twoSided,
    cancellable: input.twoSided ? false : !!input.cancellable,
    salt: input.salt ?? randomSalt(),
    condition,
  };
}

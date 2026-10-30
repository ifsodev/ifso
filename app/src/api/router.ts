import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, or, desc } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { erc8056Abi, ifsoEscrowAbi, usdgAbi } from "../abi";
import { BuildError, DEFAULTS, buildParams, type BuildInput } from "../core/builder";
import { conditionHash, createAuthNonce, escrowId } from "../core/condition";
import { copy } from "../core/copy";
import { stockPriceConditionAllowed } from "../core/geo";
import { formatUsdg } from "../core/money";
import { describeCondition, parseCommand, type ConditionDraft } from "../core/parser";
import { createAuthorizationTypedData } from "../core/typedData";
import { Kind, type CreateParams } from "../core/types";
import { SEED_FEEDS } from "../config/chain";
import { escrows, intents, questions } from "../db/schema";
import { required } from "../chain";
import { sendCall } from "../workers/tx";
import type { Deps } from "../workers/deps";
import { PolymarketRefused, planFootballQuestion, planPolymarketQuestion, polymarketLooksDecided, registerPlanned } from "../workers/resolver";
import { ClaimError, readEscrow, relayAccept, relayClaim } from "./claim";
import { RateLimiter } from "./rateLimit";
import { findFixture } from "./fixtures";
import { holderTier, tierConfig } from "./perks";
import { parseCsv, totals, validateRows } from "./batchPlan";
import { userStats } from "./stats";
import { LIMITS, perksFor, TIER_RANK, type Tier } from "../core/perks";

export interface Ctx {
  deps: Deps;
  limiter: RateLimiter;
  ip: string;
  country?: string;
}

const t = initTRPC.context<Ctx>().create();
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((a) => getAddress(a) as Address);
const hex = z.string().regex(/^0x[0-9a-fA-F]*$/).transform((h) => h as Hex);
const uint = z.string().regex(/^\d+$/).transform((s) => BigInt(s));

export const jsonSafe = <T>(v: T): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));

export function paramsFromJson(j: Record<string, any>): CreateParams {
  const c = j.condition;
  return {
    amount: BigInt(j.amount),
    counterAmount: BigInt(j.counterAmount),
    recipient: j.recipient,
    linkKey: j.linkKey,
    refundTo: j.refundTo,
    altRefundTo: j.altRefundTo,
    expiry: BigInt(j.expiry),
    acceptBy: BigInt(j.acceptBy),
    twoSided: Boolean(j.twoSided),
    cancellable: Boolean(j.cancellable),
    salt: j.salt,
    condition: {
      kind: Number(c.kind),
      mode: Number(c.mode),
      op: Number(c.op),
      source: Number(c.source),
      target: c.target,
      stockToken: c.stockToken,
      key: c.key,
      threshold: BigInt(c.threshold),
      multiplier: BigInt(c.multiplier),
      outcomeMask: BigInt(c.outcomeMask),
      start: BigInt(c.start),
      deadline: BigInt(c.deadline),
      maxStale: Number(c.maxStale),
      holdWindow: Number(c.holdWindow),
    },
  };
}

function tickers(): Set<string> {
  return new Set(SEED_FEEDS.map((f) => f.ticker));
}

function gateDraft(ctx: Ctx, d: ConditionDraft | undefined) {
  if (d?.kind !== "PRICE") return;
  const feed = SEED_FEEDS.find((f) => f.ticker === d.ticker);
  if (feed?.isStock && !stockPriceConditionAllowed(ctx.country)) {
    throw new TRPCError({ code: "FORBIDDEN", message: copy.preview.geoBlockedPrice });
  }
}

const tooMany = (message: string) => new TRPCError({ code: "TOO_MANY_REQUESTS", message });

/** Budgets for relayed calls (we pay the gas): per client network and per signing wallet, per hour. */
export async function relayBudget(ctx: Ctx, signer?: Address) {
  const { env } = ctx.deps;
  const ipHash = RateLimiter.ipHash(ctx.ip, env.IP_HASH_SALT);
  if (!(await ctx.limiter.hit(`relay:ip:${ipHash}`, env.RELAY_PER_IP_PER_HOUR, 3600))) throw tooMany("too many requests from this network, try again later");
  // holders get a larger per-wallet budget; the tier is read on the server (fails closed to the base budget)
  const factor = signer ? LIMITS[await holderTier(ctx.deps, signer)].relayBudgetFactor : 1;
  if (signer && !(await ctx.limiter.hit(`relay:signer:${signer.toLowerCase()}`, env.RELAY_PER_SIGNER_PER_HOUR * factor, 3600))) throw tooMany("too many requests for this wallet, try again later");
  return ipHash;
}

/** Decisions and refund redirects per escrow per day: a real escrow needs a handful, never hundreds. */
async function escrowDailyCap(ctx: Ctx, id: bigint) {
  if (!(await ctx.limiter.hit(`relay:escrow:${id}`, ctx.deps.env.RELAY_PER_ESCROW_PER_DAY, 86400))) throw tooMany("too many changes to this payment today, try again tomorrow");
}

const F_SENDER_OK = 8;
const F_RECIPIENT_OK = 16;

/** Gate before a new question is planned: per network and per sender. */
function questionBudget(ctx: Ctx, sender: Address) {
  return async () => {
    const { env } = ctx.deps;
    const ipHash = RateLimiter.ipHash(ctx.ip, env.IP_HASH_SALT);
    if (!(await ctx.limiter.hit(`question:ip:${ipHash}`, env.BUILD_QUESTIONS_PER_IP_PER_HOUR, 3600))) throw tooMany("too many new questions from this network, try again later");
    if (!(await ctx.limiter.hit(`question:sender:${sender.toLowerCase()}`, env.BUILD_QUESTIONS_PER_SENDER_PER_HOUR, 3600))) throw tooMany("too many new questions from this wallet, try again later");
  };
}

/**
 * A question is registered on the resolver only for a sender who holds the funds for a create (balance covers the
 * result fee and the sponsored minimum). Build plans it off-chain; this registers it. Rate limited like build.
 */
async function registerForFundedSender(ctx: Ctx, questionId: Hex, sender: Address, needed: bigint) {
  const { deps } = ctx;
  const [row] = await deps.db.select().from(questions).where(eq(questions.id, questionId));
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "unknown question: build the payment first" });
  if (row.state !== 0) return; // already on the resolver
  await relayBudget(ctx, sender);
  const balance = await deps.clients.publicClient.readContract({ address: deps.clients.usdg, abi: usdgAbi, functionName: "balanceOf", args: [sender] });
  if (balance < needed) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "the sending wallet does not hold enough USDG for this payment" });
  try {
    await registerPlanned(deps, questionId);
  } catch (e) {
    throw new TRPCError({ code: "BAD_REQUEST", message: String((e as Error).message).slice(0, 200) });
  }
}

const buildInput = z.object({
  text: z.string().min(3).max(300).optional(),
  intentId: z.string().uuid().optional(),
  sender: addr,
  recipient: addr.optional(),
  linkKey: addr.optional(),
  referee: addr.optional(),
  altRefundTo: addr.optional(),
  cancellable: z.boolean().optional(),
  tzOffsetMin: z.number().int().min(-720).max(840).optional(),
});

/** A perk endpoint's answer when the wallet is below the tier it needs. Never an error: the page shows it as locked. */
async function perkGate(ctx: Ctx, wallet: Address, min: Tier) {
  const tier = await holderTier(ctx.deps, wallet);
  const state = perksFor(tier, tierConfig(ctx.deps));
  const allowed = state.tokenLive && TIER_RANK[tier] >= TIER_RANK[min];
  return { allowed, tier: state.tier, state };
}
const lockedAnswer = (g: Awaited<ReturnType<typeof perkGate>>) => ({ ok: false as const, locked: true as const, tier: g.tier, wording: g.state.wording || g.state.note, locked_perks: g.state.locked });

const planRowsInput = z.object({
  sender: addr,
  csv: z.string().max(200_000).optional(),
  items: z.array(z.object({ recipient: z.string().max(80), amountUsdg: z.string().max(30) })).max(5_000).optional(),
});

export const appRouter = t.router({
  /**
   * Holder perks for a wallet. The tier is computed HERE from the token's balanceOf at request time (short cache);
   * any tier a client sends is ignored. No token address configured = everything locked, no chain call.
   */
  perks: t.procedure.input(z.object({ address: addr })).query(async ({ input, ctx }) => {
    const tier = await holderTier(ctx.deps, input.address);
    const s = perksFor(tier, tierConfig(ctx.deps));
    return { tier: s.tier, unlocked: s.unlocked, locked: s.locked, wording: s.wording, limits: s.limits, tokenLive: s.tokenLive, note: s.note };
  }),

  /** Real-user counter from indexed chain events (our own wallets excluded). `since` = YYYY-MM-DD, optional. */
  stats: t.procedure.input(z.object({ since: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).optional()).query(async ({ input, ctx }) => {
    const sinceSec = input?.since ? Math.floor(Date.parse(`${input.since}T00:00:00Z`) / 1000) : undefined;
    return userStats(ctx.deps, sinceSec);
  }),

  /** Premium: plan a bulk / CSV createBatch run (validation, totals, per-tier size limit). Sends nothing. */
  planBatch: t.procedure.input(planRowsInput).mutation(async ({ input, ctx }) => {
    const g = await perkGate(ctx, input.sender, "holder");
    if (!g.allowed) return lockedAnswer(g);
    const parsed = input.csv !== undefined ? parseCsv(input.csv) : { rows: (input.items ?? []).map((x, i) => ({ line: i + 1, ...x })), problems: [] };
    const max = g.state.limits.batchSize;
    if (parsed.rows.length > max) return { ok: false as const, locked: false as const, tier: g.tier, limit: max, reason: copy.perks.batchTooBig(String(max)) };
    const { valid, problems } = validateRows(parsed.rows);
    const fee = await ctx.deps.clients.publicClient.readContract({ address: required(ctx.deps.clients.escrow, "ESCROW_ADDRESS"), abi: ifsoEscrowAbi, functionName: "feeFor", args: [Kind.TIME] });
    return { ok: problems.length === 0, locked: false as const, tier: g.tier, limit: max, problems, totals: totals(valid, fee), rows: valid.map((v) => ({ recipient: v.recipient, amount: v.amount.toString() })) };
  }),

  /** Premium: plan scheduled payroll (rows x runs against the per-tier scheduled-payment limit). Sends nothing. */
  planPayroll: t.procedure
    .input(planRowsInput.extend({ runs: z.number().int().min(1).max(60), every: z.enum(["week", "month"]) }))
    .mutation(async ({ input, ctx }) => {
      const g = await perkGate(ctx, input.sender, "holder");
      if (!g.allowed) return lockedAnswer(g);
      const parsed = input.csv !== undefined ? parseCsv(input.csv) : { rows: (input.items ?? []).map((x, i) => ({ line: i + 1, ...x })), problems: [] };
      const scheduled = parsed.rows.length * input.runs;
      const max = g.state.limits.scheduledPayments;
      if (scheduled > max) return { ok: false as const, locked: false as const, tier: g.tier, limit: max, reason: copy.perks.scheduleTooBig(String(max)) };
      const { valid, problems } = validateRows(parsed.rows);
      const fee = await ctx.deps.clients.publicClient.readContract({ address: required(ctx.deps.clients.escrow, "ESCROW_ADDRESS"), abi: ifsoEscrowAbi, functionName: "feeFor", args: [Kind.TIME] });
      const per = totals(valid, fee);
      return { ok: problems.length === 0, locked: false as const, tier: g.tier, limit: max, scheduled, every: input.every, runs: input.runs, problems, perRun: per, rows: valid.map((v) => ({ recipient: v.recipient, amount: v.amount.toString() })) };
    }),

  /** Parse free text into a condition draft + preview (no chain writes). */
  parse: t.procedure
    .input(z.object({ text: z.string().min(3).max(300), tzOffsetMin: z.number().int().optional() }))
    .query(({ input, ctx }) => {
      const r = parseCommand(input.text, { nowMs: Date.now(), tzOffsetMin: input.tzOffsetMin, tickers: tickers() });
      if (r.condition?.kind === "PRICE") {
        const feed = SEED_FEEDS.find((f) => f.ticker === (r.condition as { ticker: string }).ticker);
        if (feed?.isStock && !stockPriceConditionAllowed(ctx.country)) r.errors.push(copy.preview.geoBlockedPrice);
      }
      return r;
    }),

  /** Build exact CreateParams + the EIP-3009 typed data the sender signs (gasless create). The link secret
   *  stays in the browser: only its derived address (linkKey) is sent here. */
  build: t.procedure.input(buildInput).mutation(async ({ input, ctx }) => {
    const { deps } = ctx;
    let text = input.text;
    let tzOffsetMin = input.tzOffsetMin;
    if (input.intentId) {
      const [it] = await deps.db.select().from(intents).where(eq(intents.id, input.intentId));
      if (!it) throw new TRPCError({ code: "NOT_FOUND" });
      text = it.text ?? undefined;
      tzOffsetMin = it.tzOffsetMin ?? tzOffsetMin; // the offset the bot used, so the deadline is the same instant
    }
    if (!text) throw new TRPCError({ code: "BAD_REQUEST", message: "text or intentId required" });
    const parsed = parseCommand(text, { nowMs: Date.now(), tzOffsetMin, tickers: tickers() });
    if (!parsed.ok || !parsed.condition) throw new TRPCError({ code: "BAD_REQUEST", message: [...parsed.errors, ...parsed.ambiguities].join(" ") });
    gateDraft(ctx, parsed.condition);

    const escrowAddr = required(deps.clients.escrow, "ESCROW_ADDRESS");
    const nowSec = Math.floor(Date.now() / 1000);
    const bi: BuildInput = {
      draft: parsed.condition,
      nowSec,
      amountUsdg: parsed.amountUsdg!,
      counterAmountUsdg: parsed.counterAmountUsdg,
      twoSided: parsed.twoSided,
      recipient: parsed.recipient?.type === "address" ? (getAddress(parsed.recipient.address) as Address) : input.recipient,
      linkKey: parsed.recipient?.type === "address" ? undefined : input.linkKey,
      referee: input.referee,
      altRefundTo: input.altRefundTo,
      cancellable: input.cancellable,
    };
    const d = parsed.condition;
    if (d.kind === "PRICE") {
      const f = SEED_FEEDS.find((x) => x.ticker === d.ticker);
      if (!f) throw new TRPCError({ code: "BAD_REQUEST", message: copy.parse.unknownTicker(d.ticker) });
      const multiplier = f.stockToken
        ? await deps.clients.publicClient.readContract({ address: f.stockToken, abi: erc8056Abi, functionName: "uiMultiplier" })
        : 0n;
      if (f.isStock && !f.stockToken) throw new TRPCError({ code: "PRECONDITION_FAILED", message: copy.parse.unknownTicker(d.ticker) });
      bi.feed = { feed: f.feed, stockToken: f.stockToken, multiplier };
    } else if (d.kind === "SPORTS") {
      const fx = await findFixture(deps, d.team, d.opponent, d.on);
      if (fx.ambiguous) throw new TRPCError({ code: "BAD_REQUEST", message: `Which team: ${fx.ambiguous.join(" or ")}?` });
      if (!fx.fixture) throw new TRPCError({ code: "NOT_FOUND", message: copy.parse.unknownCondition(`${d.team} ${d.result.toLowerCase()}`) });
      // the fixture comes from our own league listing (the allow-list); the question is only PLANNED here
      const q = await planFootballQuestion(deps, fx.fixture, questionBudget(ctx, input.sender));
      bi.outcome = { resolver: required(deps.clients.resolverContract, "RESOLVER_ADDRESS"), questionId: q.id, earliestResolve: q.earliestResolve, teamIsHome: fx.teamIsHome, closeTime: q.closeTime, challengeMargin: DEFAULTS.sportsChallengeMargin };
    } else if (d.kind === "MARKET") {
      if (d.venue !== "polymarket") throw new TRPCError({ code: "BAD_REQUEST", message: "Hyperliquid questions arrive in phase 2." });
      const slug = d.ref.replace(/^https?:\/\/(www\.)?polymarket\.com\/(event|market)\//, "").split(/[/?#]/)[0]!;
      let q;
      try {
        q = await planPolymarketQuestion(deps, slug, questionBudget(ctx, input.sender)); // allow-list: open, binary, liquid, traded, sane end date
      } catch (e) {
        if (e instanceof PolymarketRefused) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
        throw e;
      }
      if (parsed.twoSided && polymarketLooksDecided(q.market)) throw new TRPCError({ code: "BAD_REQUEST", message: "This market is already priced as nearly decided, so it cannot be used for a challenge." });
      bi.outcome = { resolver: required(deps.clients.resolverContract, "RESOLVER_ADDRESS"), questionId: q.id, earliestResolve: q.earliestResolve, closeTime: q.closeTime, challengeMargin: DEFAULTS.polymarketChallengeMargin };
    }

    let params: CreateParams;
    try {
      params = buildParams(bi);
    } catch (e) {
      if (e instanceof BuildError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message });
      throw e;
    }
    const fee = await deps.clients.publicClient.readContract({ address: escrowAddr, abi: ifsoEscrowAbi, functionName: "feeFor", args: [params.condition.kind] });
    const value = params.amount + fee;
    const validAfter = BigInt(nowSec - 60);
    const validBefore = BigInt(nowSec + 3600);
    const nonce = createAuthNonce(input.sender, params);
    const id = escrowId(input.sender, params.salt);
    if (input.intentId) {
      await deps.db.update(intents).set({ params: jsonSafe(params), sender: input.sender.toLowerCase(), escrowId: id.toString(), state: "built" }).where(eq(intents.id, input.intentId));
    }
    return jsonSafe({
      id,
      params,
      conditionHash: conditionHash(params.condition),
      fee,
      feeText: copy.preview.fee(formatUsdg(fee)),
      total: value,
      preview: parsed.preview,
      notes: parsed.notes,
      expiryText: copy.preview.expiry(new Date(Number(params.expiry) * 1000).toUTCString()),
      authorization: { validAfter, validBefore, nonce, typedData: createAuthorizationTypedData({ chainId: deps.clients.chain.id, usdg: deps.clients.usdg, escrow: escrowAddr, from: input.sender, value, validAfter, validBefore, nonce }) },
    });
  }),

  /** Relays a gasless create (sender signed ReceiveWithAuthorization for exactly these params). */
  submit: t.procedure
    .input(z.object({ params: z.record(z.any()), from: addr, validAfter: uint, validBefore: uint, signature: hex, intentId: z.string().uuid().optional() }))
    .mutation(async ({ input, ctx }) => {
      const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
      const p = paramsFromJson(input.params);
      if (p.condition.kind === Kind.PRICE) gateDraft(ctx, { kind: "PRICE", ticker: SEED_FEEDS.find((f) => f.feed.toLowerCase() === p.condition.target.toLowerCase())?.ticker ?? "", op: "GTE", priceUsd: "0", mode: "AT_DEADLINE", deadline: 0 });
      const ipHash = await relayBudget(ctx, input.from);
      if (p.condition.kind === Kind.OUTCOME) {
        const fee = await ctx.deps.clients.publicClient.readContract({ address: escrowAddr, abi: ifsoEscrowAbi, functionName: "feeFor", args: [p.condition.kind] });
        await registerForFundedSender(ctx, p.condition.key as Hex, input.from, p.amount + fee);
      }
      const r = await sendCall(
        ctx.deps,
        ctx.deps.clients.relayer,
        { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "createWithAuthorization", args: [p as never, input.from, input.validAfter, input.validBefore, input.signature] },
        { kind: "create", escrowId: escrowId(input.from, p.salt).toString(), ipHash },
      );
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "create failed" });
      if (input.intentId) await ctx.deps.db.update(intents).set({ state: "submitted", txHash: r.hash }).where(eq(intents.id, input.intentId));
      return { txHash: r.hash, id: escrowId(input.from, p.salt).toString() };
    }),

  /**
   * Registers a planned outcome question on the resolver, for a sender who creates the escrow themselves (not through
   * `submit`, which does this on its own). Needs the sender's USDG balance to cover the result fee plus the minimum.
   */
  prepareQuestion: t.procedure.input(z.object({ questionId: hex, sender: addr })).mutation(async ({ input, ctx }) => {
    const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
    const fee = await ctx.deps.clients.publicClient.readContract({ address: escrowAddr, abi: ifsoEscrowAbi, functionName: "feeFor", args: [Kind.OUTCOME] });
    await registerForFundedSender(ctx, input.questionId, input.sender, fee + BigInt(Math.round(ctx.deps.env.SPONSOR_MIN_AMOUNT_USDG * 1e6)));
    return { ok: true };
  }),

  /** Claim page: everything shown is read from the chain, not from the URL (anti-phishing). */
  escrow: t.procedure.input(z.object({ id: uint })).query(async ({ input, ctx }) => {
    const { e, c } = await readEscrow(ctx.deps, input.id);
    if (e.status === 0) throw new TRPCError({ code: "NOT_FOUND" });
    return jsonSafe({ escrow: e, condition: c, amountText: formatUsdg(e.amount) });
  }),

  claim: t.procedure.input(z.object({ id: uint, recipient: addr, signature: hex })).mutation(async ({ input, ctx }) => {
    try {
      return await relayClaim(ctx.deps, ctx.limiter, { ...input, ip: ctx.ip });
    } catch (e) {
      if (e instanceof ClaimError) throw new TRPCError({ code: e.code === "RATE_LIMITED" ? "TOO_MANY_REQUESTS" : "BAD_REQUEST", message: e.message, cause: e });
      throw e;
    }
  }),

  accept: t.procedure
    .input(z.object({ id: uint, acceptor: addr, linkSig: hex, counterRefundTo: addr, validAfter: uint, validBefore: uint, authSig: hex }))
    .mutation(async ({ input, ctx }) => {
      await relayBudget(ctx, input.acceptor);
      try {
        return await relayAccept(ctx.deps, input);
      } catch (e) {
        if (e instanceof ClaimError) throw new TRPCError({ code: "BAD_REQUEST", message: e.message, cause: e });
        throw e;
      }
    }),

  /** Relayed EIP-712 Decision (tap OK / decline / referee). */
  decide: t.procedure
    .input(z.object({ id: uint, signer: addr, action: z.number().int().min(1).max(4), deadline: uint, signature: hex }))
    .mutation(async ({ input, ctx }) => {
      const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
      const ipHash = await relayBudget(ctx, input.signer);
      // a repeat OK changes nothing on chain but still costs gas: refuse it before anything is sent
      const { e } = await readEscrow(ctx.deps, input.id);
      if (input.action === 1) {
        const flag = input.signer.toLowerCase() === String(e.sender ?? "").toLowerCase() ? F_SENDER_OK : input.signer.toLowerCase() === String(e.recipient ?? "").toLowerCase() ? F_RECIPIENT_OK : 0;
        if (flag && (Number(e.flags) & flag) !== 0) throw new TRPCError({ code: "BAD_REQUEST", message: "this approval is already recorded" });
      }
      await escrowDailyCap(ctx, input.id);
      const r = await sendCall(ctx.deps, ctx.deps.clients.relayer, { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "decideBySig", args: [input.id, input.signer, input.action, input.deadline, input.signature] }, { kind: "decision", escrowId: input.id.toString(), ipHash });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "decision failed" });
      return { txHash: r.hash };
    }),

  /** Relayed refund redirect (sender signs; useful when the sender's own address can't transact). */
  redirectRefund: t.procedure
    .input(z.object({ id: uint, refundTo: addr, altRefundTo: addr, deadline: uint, signature: hex }))
    .mutation(async ({ input, ctx }) => {
      const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
      const ipHash = await relayBudget(ctx);
      const { e } = await readEscrow(ctx.deps, input.id);
      const same = (a: unknown, b: string) => String(a ?? "").toLowerCase() === b.toLowerCase();
      if (same(e.refundTo, input.refundTo) && same(e.altRefundTo, input.altRefundTo)) throw new TRPCError({ code: "BAD_REQUEST", message: "the refund addresses are already set to these" });
      await escrowDailyCap(ctx, input.id);
      const r = await sendCall(ctx.deps, ctx.deps.clients.relayer, { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "setRefundAddressesBySig", args: [input.id, input.refundTo, input.altRefundTo, input.deadline, input.signature] }, { kind: "redirect", escrowId: input.id.toString(), ipHash });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "redirect failed" });
      return { txHash: r.hash };
    }),

  mine: t.procedure.input(z.object({ address: addr })).query(async ({ input, ctx }) => {
    const a = input.address.toLowerCase();
    const rows = await ctx.deps.db.select().from(escrows).where(or(eq(escrows.sender, a), eq(escrows.recipient, a))).orderBy(desc(escrows.createdBlock)).limit(100);
    return jsonSafe(rows);
  }),

  question: t.procedure.input(z.object({ specHash: hex })).query(async ({ input, ctx }) => {
    const [q] = await ctx.deps.db.select().from(questions).where(eq(questions.specHash, input.specHash));
    if (!q) throw new TRPCError({ code: "NOT_FOUND" });
    return jsonSafe({ id: q.id, spec: q.spec, title: q.title, state: q.state, finalOutcome: q.finalOutcome });
  }),

  describe: t.procedure.input(z.object({ text: z.string().min(3).max(300) })).query(({ input }) => {
    const r = parseCommand(input.text, { nowMs: Date.now(), tickers: tickers() });
    return r.condition ? describeCondition(r.condition) : null;
  }),
});

export type AppRouter = typeof appRouter;

import { initTRPC, TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq, or, desc } from "drizzle-orm";
import { getAddress, type Address, type Hex } from "viem";
import { erc8056Abi, ifsoEscrowAbi } from "../abi";
import { buildParams, type BuildInput } from "../core/builder";
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
import { ensureFootballQuestion, ensurePolymarketQuestion } from "../workers/resolver";
import { ClaimError, readEscrow, relayAccept, relayClaim } from "./claim";
import { findFixture } from "./fixtures";
import type { RateLimiter } from "./rateLimit";

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

export const appRouter = t.router({
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
      const q = await ensureFootballQuestion(deps, fx.fixture);
      bi.outcome = { resolver: required(deps.clients.resolverContract, "RESOLVER_ADDRESS"), questionId: q.id, earliestResolve: q.earliestResolve, teamIsHome: fx.teamIsHome };
      if (parsed.twoSided && q.closeTime <= nowSec + 600) throw new TRPCError({ code: "BAD_REQUEST", message: "This match is about to start; challenges close at kickoff." });
    } else if (d.kind === "MARKET") {
      if (d.venue !== "polymarket") throw new TRPCError({ code: "BAD_REQUEST", message: "Hyperliquid questions arrive in phase 2." });
      const slug = d.ref.replace(/^https?:\/\/(www\.)?polymarket\.com\/(event|market)\//, "").split(/[/?#]/)[0]!;
      const q = await ensurePolymarketQuestion(deps, slug);
      bi.outcome = { resolver: required(deps.clients.resolverContract, "RESOLVER_ADDRESS"), questionId: q.id, earliestResolve: q.earliestResolve };
    }

    const params = buildParams(bi);
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
      const r = await sendCall(
        ctx.deps,
        ctx.deps.clients.relayer,
        { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "createWithAuthorization", args: [p as never, input.from, input.validAfter, input.validBefore, input.signature] },
        { kind: "create", escrowId: escrowId(input.from, p.salt).toString() },
      );
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "create failed" });
      if (input.intentId) await ctx.deps.db.update(intents).set({ state: "submitted", txHash: r.hash }).where(eq(intents.id, input.intentId));
      return { txHash: r.hash, id: escrowId(input.from, p.salt).toString() };
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
    .mutation(async ({ input, ctx }) => relayAccept(ctx.deps, input)),

  /** Relayed EIP-712 Decision (tap OK / decline / referee). */
  decide: t.procedure
    .input(z.object({ id: uint, signer: addr, action: z.number().int().min(1).max(4), deadline: uint, signature: hex }))
    .mutation(async ({ input, ctx }) => {
      const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
      const r = await sendCall(ctx.deps, ctx.deps.clients.relayer, { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "decideBySig", args: [input.id, input.signer, input.action, input.deadline, input.signature] }, { kind: "decision", escrowId: input.id.toString() });
      if (!r.ok) throw new TRPCError({ code: "BAD_REQUEST", message: r.error ?? "decision failed" });
      return { txHash: r.hash };
    }),

  /** Relayed refund redirect (sender signs; useful when the sender's own address can't transact). */
  redirectRefund: t.procedure
    .input(z.object({ id: uint, refundTo: addr, altRefundTo: addr, deadline: uint, signature: hex }))
    .mutation(async ({ input, ctx }) => {
      const escrowAddr = required(ctx.deps.clients.escrow, "ESCROW_ADDRESS");
      const r = await sendCall(ctx.deps, ctx.deps.clients.relayer, { address: escrowAddr, abi: ifsoEscrowAbi, functionName: "setRefundAddressesBySig", args: [input.id, input.refundTo, input.altRefundTo, input.deadline, input.signature] }, { kind: "redirect", escrowId: input.id.toString() });
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

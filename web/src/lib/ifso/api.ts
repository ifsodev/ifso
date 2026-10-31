/**
 * Typed client for the IFSO API (a tRPC router over plain HTTP: queries are GET /trpc/<name>?input=<json>, mutations are
 * POST /trpc/<name> with a JSON body). It is called from the visitor's browser, never from a server function, because the
 * country and the client address come from the request's edge headers. Shapes follow FRONTEND.md / app/src/api/router.ts.
 */
import type { Address, Hex } from "viem";
import { config } from "./config";

/** The router type the shared client package re-exports; the site talks to it through `Api` below. */
export type AppRouter = unknown;

export type ApiCode = "BAD_REQUEST" | "NOT_FOUND" | "FORBIDDEN" | "PRECONDITION_FAILED" | "TOO_MANY_REQUESTS" | "INTERNAL_SERVER_ERROR" | "NETWORK";

export class ApiError extends Error {
  constructor(
    public readonly code: ApiCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** Text for the screen. API messages are written for users and shown as they are; the rest get a calm default. */
export function friendlyError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "TOO_MANY_REQUESTS") return "Too many requests right now. Try again in a little while.";
    if (e.code === "NETWORK") return "The service could not be reached. Check your connection and try again.";
    if (e.code === "INTERNAL_SERVER_ERROR") return "Something went wrong on our side. Nothing was sent. Try again in a little while.";
    return e.message;
  }
  if (e && typeof e === "object" && "shortMessage" in e && typeof (e as { shortMessage: unknown }).shortMessage === "string") return (e as { shortMessage: string }).shortMessage;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}

export interface QuestionOption {
  label: string;
  text?: string;
  replace?: [from: string, to: string];
}
export interface ParseQuestion {
  kind: "direction" | "date_format" | "deadline" | "weekend" | "team" | "touch_challenge";
  text: string;
  options: QuestionOption[];
}
export interface ParseResult {
  ok: boolean;
  twoSided: boolean;
  recipient?: { type: "handle" | "address" | "link"; handle?: string; address?: Address };
  amountUsdg?: string;
  counterAmountUsdg?: string;
  condition?: { kind: string };
  ambiguities: string[];
  questions: ParseQuestion[];
  notes: string[];
  errors: string[];
  preview?: string;
  feeUsdg?: string;
  expiry?: number;
}
export interface BuildInput {
  text?: string;
  sender: Address;
  recipient?: Address;
  linkKey?: Address;
  referee?: Address;
  altRefundTo?: Address;
  cancellable?: boolean;
  tzOffsetMin?: number;
}
export interface BuildAnswer {
  id: string;
  params: Record<string, unknown>;
  conditionHash: Hex;
  fee: string;
  feeText: string;
  total: string;
  preview?: string;
  notes: string[];
  expiryText: string;
  authorization: {
    validAfter: string;
    validBefore: string;
    nonce: Hex;
    typedData: { domain: Record<string, unknown>; types: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
  };
}
export interface EscrowRow {
  sender: Address;
  recipient: Address;
  amount: string;
  counterAmount: string;
  linkKey: Address;
  status: number;
  flags: number;
  expiry: string;
  acceptBy: string;
  refundTo: Address;
  altRefundTo: Address;
  conditionHash: Hex;
  [k: string]: unknown;
}
export interface EscrowView {
  escrow: EscrowRow;
  condition: Record<string, unknown>;
  amountText: string;
}
export interface MineRow {
  id: string;
  sender: string;
  recipient: string | null;
  amount: string;
  counterAmount: string;
  kind: number;
  status: number;
  twoSided: boolean;
  accepted: boolean;
  voidOwed: number;
  expiry: string;
  acceptBy: string | null;
  createdTx: string;
  conditionHash: string;
  linkKey: string | null;
  [k: string]: unknown;
}
export interface PerksAnswer {
  tier: "none" | "holder" | "whale";
  unlocked: unknown[];
  locked: { id: string; text: string; unlockText: string }[];
  wording: string;
  tokenLive: boolean;
  note: string;
}
export interface GeoAnswer {
  country: string | null;
  stockPriceConditionsAllowed: boolean;
}
export interface HealthAnswer {
  ok: boolean;
  chainId: number;
  escrow: Address | null;
}

export interface Api {
  health(): Promise<HealthAnswer>;
  geo(): Promise<GeoAnswer>;
  parse(input: { text: string; tzOffsetMin?: number }): Promise<ParseResult>;
  describe(input: { text: string }): Promise<string | null>;
  build(input: BuildInput): Promise<BuildAnswer>;
  submit(input: { params: Record<string, unknown>; from: Address; validAfter: string; validBefore: string; signature: Hex }): Promise<{ txHash: Hex; id: string }>;
  prepareQuestion(input: { questionId: Hex; sender: Address }): Promise<{ ok: true }>;
  escrow(input: { id: string }): Promise<EscrowView>;
  claim(input: { id: string; recipient: Address; signature: Hex }): Promise<{ txHash: Hex; status: "bound" | "paid" }>;
  accept(input: { id: string; acceptor: Address; linkSig: Hex; counterRefundTo: Address; validAfter: string; validBefore: string; authSig: Hex }): Promise<{ txHash: Hex }>;
  decide(input: { id: string; signer: Address; action: number; deadline: string; signature: Hex }): Promise<{ txHash: Hex }>;
  redirectRefund(input: { id: string; refundTo: Address; altRefundTo: Address; deadline: string; signature: Hex }): Promise<{ txHash: Hex }>;
  mine(input: { address: Address }): Promise<MineRow[]>;
  perks(input: { address: Address }): Promise<PerksAnswer>;
  linkWallet(input: { token: string; address: Address; signature: Hex }): Promise<{ address: Address }>;
}

type Fetch = typeof fetch;

/** `base` is the API origin (no trailing slash). `fetchImpl` is replaceable for tests. */
export function createApi(base: string, fetchImpl: Fetch = (...a) => fetch(...a)): Api {
  async function call<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method,
        headers: body === undefined ? undefined : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new ApiError("NETWORK", "network error");
    }
    const json = (await res.json().catch(() => null)) as { result?: { data: T }; error?: { message?: string; data?: { code?: ApiCode } } } | T | null;
    if (json && typeof json === "object" && "error" in json && json.error) {
      throw new ApiError(json.error.data?.code ?? "INTERNAL_SERVER_ERROR", json.error.message ?? "request failed");
    }
    if (!res.ok) throw new ApiError(res.status === 429 ? "TOO_MANY_REQUESTS" : res.status >= 500 ? "INTERNAL_SERVER_ERROR" : "BAD_REQUEST", "request failed");
    if (json && typeof json === "object" && "result" in json && json.result) return json.result.data;
    return json as T;
  }
  const q = <T>(name: string, input?: unknown) => call<T>("GET", `${base}/trpc/${name}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}`);
  const m = <T>(name: string, input: unknown) => call<T>("POST", `${base}/trpc/${name}`, input);
  return {
    health: () => call("GET", `${base}/healthz`),
    geo: () => call("GET", `${base}/geo`),
    parse: (i) => q("parse", i),
    describe: (i) => q("describe", i),
    build: (i) => m("build", i),
    submit: (i) => m("submit", i),
    prepareQuestion: (i) => m("prepareQuestion", i),
    escrow: (i) => q("escrow", i),
    claim: (i) => m("claim", i),
    accept: (i) => m("accept", i),
    decide: (i) => m("decide", i),
    redirectRefund: (i) => m("redirectRefund", i),
    mine: (i) => q("mine", i),
    perks: (i) => q("perks", i),
    linkWallet: (i) => m("linkWallet", i),
  };
}

export const api: Api = createApi(config.apiUrl);

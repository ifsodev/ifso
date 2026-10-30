import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

export const DEFAULT_RPC_URLS = "https://rpc.mainnet.chain.robinhood.com,https://robinhood.daybreak-rpc.network";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_APP_URL: z.string().url().default("https://ifso.app"),
  CHAIN_ID: z.coerce.number().default(4663),
  RHC_RPC_URLS: z.string().default(DEFAULT_RPC_URLS), // comma separated, tried in this order
  RHC_WS_URL: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://ifso:ifso@localhost:5442/ifso"),
  REDIS_URL: z.string().default("redis://localhost:6389"),

  ESCROW_ADDRESS: addr.optional(),
  EVALUATOR_ADDRESS: addr.optional(),
  RESOLVER_ADDRESS: addr.optional(),
  USDG_ADDRESS: addr.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  ESCROW_DEPLOY_BLOCK: z.coerce.bigint().default(0n),
  CONFIRMATIONS: z.coerce.bigint().min(0n).default(3n), // the indexer trails the head by this many blocks
  KEEPER_SHADOW: z.string().optional(), //  "1": keeper and price watcher log decisions next to eth_call, never send

  // hot keys: encrypted keystore JSON v3 + password file (production). Raw *_PK is for a local anvil only (chain 31337).
  RELAYER_KEYSTORE: z.string().optional(), //  submits claims / gasless creates / decisions (pays gas, can't redirect funds)
  RELAYER_PASSWORD_FILE: z.string().optional(),
  KEEPER_KEYSTORE: z.string().optional(), //   settle + refund sweeps
  KEEPER_PASSWORD_FILE: z.string().optional(),
  RESOLVER_KEYSTORE: z.string().optional(), // registers questions, proposes outcomes (holds USDG for bonds)
  RESOLVER_PASSWORD_FILE: z.string().optional(),
  RELAYER_PK: hex.optional(),
  KEEPER_PK: hex.optional(),
  RESOLVER_PK: hex.optional(),

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  // ops alerts (Telegram ops chat). Log-only unless ALERTS_ARMED=1.
  OPS_CHAT_ID: z.string().optional(),
  OPS_BOT_TOKEN: z.string().optional(), // falls back to TELEGRAM_BOT_TOKEN
  ALERTS_ARMED: z.string().optional(),
  MIN_RELAYER_ETH: z.coerce.number().default(0.002),
  MIN_KEEPER_ETH: z.coerce.number().default(0.002),
  MIN_RESOLVER_ETH: z.coerce.number().default(0.002),
  MIN_RESOLVER_USDG: z.coerce.number().default(50),
  IP_HASH_SALT: z.string().optional(), // secret salt for stored IP hashes (required in production)

  ODDS_API_KEY: z.string().optional(), // the-odds-api.com (scores endpoint)
  SECOND_SPORTS_SOURCE: z.enum(["thesportsdb", "none"]).default("thesportsdb"),
  THESPORTSDB_KEY: z.string().default("3"), // public free key
  POLYGON_RPC_URL: z.string().url().optional(), // cross-check Polymarket CTF payouts on-chain
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_API_KEY: z.string().optional(),

  ZERODEV_PROJECT_ID: z.string().optional(),
  ALCHEMY_KEY: z.string().optional(),

  CLAIM_RELAY_PER_IP_PER_HOUR: z.coerce.number().default(20),
  SPONSOR_MIN_AMOUNT_USDG: z.coerce.number().default(1),
});

export type Env = z.infer<typeof schema>;
export type Role = "api" | "bot" | "worker" | "all";
export const ROLES: readonly Role[] = ["api", "bot", "worker", "all"];
export type HotKeyName = "RELAYER" | "KEEPER" | "RESOLVER";

/** Thrown at boot when a role is missing variables. Carries variable NAMES only, never values. */
export class EnvError extends Error {
  constructor(public readonly role: string, public readonly missing: string[]) {
    super(`missing environment variables for role "${role}": ${missing.join(", ")}`);
  }
}

const present = (src: Record<string, string | undefined>, k: string) => (src[k] ?? "").trim() !== "";

/** A hot key counts as configured with a keystore + password file pair, or (local anvil only) a raw key. */
const hotKeyNeeds = (src: Record<string, string | undefined>, name: HotKeyName): string[] => {
  if (present(src, `${name}_KEYSTORE`) && present(src, `${name}_PASSWORD_FILE`)) return [];
  if (present(src, `${name}_PK`)) return []; // key.ts refuses this outside a local chain
  const need = [`${name}_KEYSTORE`, `${name}_PASSWORD_FILE`].filter((k) => !present(src, k));
  return need;
};

/** Variables each role cannot start without. A role never needs another role's variables. */
export function missingFor(role: Role, src: Record<string, string | undefined>): string[] {
  const need: string[] = [];
  const want = (...names: string[]) => names.forEach((n) => !present(src, n) && need.push(n));
  const api = role === "api" || role === "all";
  const bot = role === "bot" || role === "all";
  const worker = role === "worker" || role === "all";
  if (api || bot || worker) want("DATABASE_URL", "ESCROW_ADDRESS");
  if (api || worker) want("REDIS_URL");
  if (api) need.push(...hotKeyNeeds(src, "RELAYER"));
  if (api && src.NODE_ENV === "production") want("IP_HASH_SALT");
  if (role === "bot") want("TELEGRAM_BOT_TOKEN"); // in "all" the bot is optional
  if (worker) {
    need.push(...hotKeyNeeds(src, "KEEPER"));
    want("RESOLVER_ADDRESS");
    need.push(...hotKeyNeeds(src, "RESOLVER"));
  }
  return [...new Set(need)];
}

/** Parse the environment. With a role, also fail fast (EnvError) when that role's variables are missing. */
export const loadEnv = (src: Record<string, string | undefined> = process.env, role?: Role): Env => {
  if (role) {
    const missing = missingFor(role, src);
    if (missing.length) throw new EnvError(role, missing);
  }
  return schema.parse(withoutBlanks(src));
};

/** A line like `ESCROW_ADDRESS=` (copied from .env.example) means "not set", so it takes the default or stays undefined. */
const withoutBlanks = (src: Record<string, string | undefined>) =>
  Object.fromEntries(Object.entries(src).filter(([, v]) => v === undefined || v.trim() !== ""));

export const rpcUrls = (env: Pick<Env, "RHC_RPC_URLS">): string[] =>
  env.RHC_RPC_URLS.split(",").map((s) => s.trim()).filter(Boolean);

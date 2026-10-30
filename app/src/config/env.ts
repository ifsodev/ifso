import { z } from "zod";

const hex = z.string().regex(/^0x[0-9a-fA-F]+$/);
const addr = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().default(8080),
  PUBLIC_APP_URL: z.string().url().default("https://ifso.app"),
  CHAIN_ID: z.coerce.number().default(4663),
  RHC_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  RHC_WS_URL: z.string().optional(),
  DATABASE_URL: z.string().default("postgres://ifso:ifso@localhost:5432/ifso"),
  REDIS_URL: z.string().default("redis://localhost:6379"),

  ESCROW_ADDRESS: addr.optional(),
  EVALUATOR_ADDRESS: addr.optional(),
  RESOLVER_ADDRESS: addr.optional(),
  USDG_ADDRESS: addr.default("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168"),
  ESCROW_DEPLOY_BLOCK: z.coerce.bigint().default(0n),

  // hot keys (each separate; fund with small ETH only)
  RELAYER_PK: hex.optional(), //  submits claims / gasless creates / decisions (pays gas, can't redirect funds)
  KEEPER_PK: hex.optional(), //   settle + refund sweeps
  RESOLVER_PK: hex.optional(), // registers questions, proposes outcomes (holds USDG for bonds)

  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_WEBHOOK_SECRET: z.string().optional(),

  ODDS_API_KEY: z.string().optional(), // the-odds-api.com (scores endpoint)
  SECOND_SPORTS_SOURCE: z.enum(["thesportsdb", "none"]).default("thesportsdb"),
  THESPORTSDB_KEY: z.string().default("3"), // public test key; paid key for production (U: ToS)
  POLYGON_RPC_URL: z.string().url().optional(), // cross-check Polymarket CTF payouts on-chain
  PYTH_HERMES_URL: z.string().url().default("https://hermes.pyth.network"),
  PYTH_API_KEY: z.string().optional(),

  ZERODEV_PROJECT_ID: z.string().optional(),
  ALCHEMY_KEY: z.string().optional(),

  CLAIM_RELAY_PER_IP_PER_HOUR: z.coerce.number().default(20),
  SPONSOR_MIN_AMOUNT_USDG: z.coerce.number().default(1),
});

export type Env = z.infer<typeof schema>;
export const loadEnv = (src: Record<string, string | undefined> = process.env): Env => schema.parse(src);

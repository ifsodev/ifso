# IFSO app (API, bot, workers)

Bun · Hono · tRPC v11 · Drizzle (Postgres 16) · BullMQ (Redis) · viem · grammY.

```bash
docker compose -f ../docker-compose.yml up -d      # postgres 5442 + redis 6389
cp .env.example .env && bun install
bun run db:migrate                                  # applies drizzle/0000_init.sql
bun run api      # Hono: /trpc/*, /tg/webhook, /q/:specHash.json, /healthz, /readyz
bun run worker   # keeper (30 s), price watcher (15 s), resolver (60 s), indexer (5 s), notifier
bun run bot      # long polling for dev (production: set TELEGRAM_WEBHOOK_SECRET; the API then serves POST /tg/<secret path>,
                 # `bun run scripts/webhook-url.ts` prints the URL and the setWebhook call without sending anything)
bun test         # parser, links + claim signatures, claim relay, typed-data parity, TS<->Solidity vectors, price
                 # evaluation, round finder, builder, API smoke, banned words, and the keeper / watcher / indexer
                 # suites on a private anvil (port 8745) + Postgres (5442); those skip when anvil or pg_ctl is missing
bunx tsc --noEmit
```

| Path | What |
|---|---|
| `src/core/` | Pure logic shared by API, bot, web app: types, condition hashing, EIP-712, links, parser, price mirror, outcome agreement, builder, money, geo, **copy.ts (every user-facing string)** |
| `src/api/` | tRPC router, Hono app, claim/accept relay, fixtures lookup, rate limiting, trusted client address (`clientIp.ts`, `TRUST_PROXY`) |
| `src/bot/` | Telegram bot: `/ifso`, `/challenge`, `/mine`, `/tz`; unclear input becomes a question with buttons, the final reply is one URL button to the web app (no Mini App) |
| `src/workers/` | keeper, price watcher, round history (phase-aware finder), Pyth fetch, outcome resolver, indexer (block-hash cursor, reorg rewind), notifier, BullMQ queues |
| `src/sources/` | The Odds API, TheSportsDB (free test key `123`), Polymarket (Gamma + Polygon CTF via `POLYGON_RPC_URL`, default a free public RPC), Hyperliquid HIP-4 (phase 2); `index.ts` is the swappable fetcher interface the resolver tests replay recorded fixtures through |
| `src/chain/` | viem clients: ordered RPC fallback + chunked `getLogs` (`rpc.ts`), keystore hot keys (`keys.ts`) |
| `src/ops/` | `/healthz` + `/readyz` probes, ops alerts (deduped, log-only unless `ALERTS_ARMED=1`), monitors |
| `src/client/claimPage.ts` | Browser claim flow (fragment read + wipe, chain-rendered details, sign, relay) |
| `src/abi/` | ABIs generated from the Solidity sources (`contracts/tools/solcjs-compile.mjs --abi-ts-out`) |
| `scripts/server/` | Server scripts for one Ubuntu 24.04 VPS: provision, deploy with rollback, systemd units, Caddy, backups; see its `README.md` |
| `scripts/print-vectors.ts` | Prints the parity vectors asserted by `contracts/test/Vectors.t.sol` |

## Relay limits, questions and challenges (security review round 1)

- **Client address and country** come from one trusted hop only (`TRUST_PROXY`, see `.env.example`). Headers a client can set
  (first `x-forwarded-for` entry, `x-country`) are never read. With the default `none` the country is unknown and Stock Token
  price conditions are refused.
- **Relayed calls** (`submit`, `accept`, `decide`, `redirectRefund`) have budgets per network, per signing wallet and, for
  decisions and refund redirects, per payment per day. A repeat approval or an unchanged refund address is refused before any
  gas is spent. Claims use a higher-priority lane in the relayer queue, so other relays cannot stall them.
- **Outcome questions**: `build` only plans a question off-chain (state 0). It is registered on the resolver when a sender who
  holds the funds calls `submit`, or `prepareQuestion` for senders who create the payment themselves. Polymarket markets must be
  open, Yes/No, liquid and traded, and end within `POLYMARKET_MAX_DAYS_OUT` days. The close time is the earlier of the market's
  end date and its own close signal. The resolver proposes only for questions with a funded payment, oldest first with a cursor.
- **Challenges**: the accept window closes before the event (10 minutes before kickoff for league fixtures, 24 hours before the
  end date for Polymarket) and strictly before an at-deadline price deadline. If less than 10 minutes would remain, the builder
  refuses. A market already priced outside 2 to 98 percent cannot be used for a challenge.
- **Keeper sweeps** skip rows that keep failing (per-escrow backoff, 2 minutes doubling to 6 hours), so a stuck row never hides the rows behind it.

## Holder perks and the real-user counter

- `perks` (tRPC query) returns `{ tier, unlocked, locked, wording, limits }` for a wallet. The tier is computed on the
  server from the token's `balanceOf` at request time (short cache, `PERKS_CACHE_SECONDS`); a tier sent by a client is
  ignored. Holder is 100,000 $IFSO and Whale is 1,000,000 (`HOLDER_MIN_IFSO`, `WHALE_MIN_IFSO`). With
  `IFSO_TOKEN_ADDRESS` empty every perk is locked ("hold 100,000 $IFSO to unlock") and no chain call is made.
- Perks: bulk / CSV batch planning (`planBatch`) and scheduled payroll planning (`planPayroll`) without a monthly fee,
  larger batch and schedule limits, and a larger per-wallet relay budget. Core features are never gated. Perks have no
  cash value and are not a promise of any amount.
- `GET /stats/users?since=YYYY-MM-DD` and the tRPC `stats` query count real users from indexed chain events: unique
  senders, unique recipients, unique challenge acceptors, escrows created and USDG volume, in total and per UTC day.
  Addresses in `INTERNAL_ADDRESSES` (our relayer, keeper, resolver, deployer and test wallets) are left out.
- `bun scripts/user-count.ts --since 2026-11-01 --escrow <address> [--internal 0x..,0x..] [--rpc <url>] [--json]` prints
  the same numbers straight from chain logs, with no database. (Volume of a challenge accepted after `--since` on an
  escrow created before it is not in the script's figure.)

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
| `src/api/` | tRPC router, Hono app, claim/accept relay, fixtures lookup, rate limiting |
| `src/bot/` | Telegram bot: `/ifso`, `/challenge`, `/mine`, `/tz`; unclear input becomes a question with buttons, the final reply is one URL button to the web app (no Mini App) |
| `src/workers/` | keeper, price watcher, round history (phase-aware finder), Pyth fetch, outcome resolver, indexer (block-hash cursor, reorg rewind), notifier, BullMQ queues |
| `src/sources/` | The Odds API, TheSportsDB (free test key `123`), Polymarket (Gamma + Polygon CTF via `POLYGON_RPC_URL`, default a free public RPC), Hyperliquid HIP-4 (phase 2); `index.ts` is the swappable fetcher interface the resolver tests replay recorded fixtures through |
| `src/chain/` | viem clients: ordered RPC fallback + chunked `getLogs` (`rpc.ts`), keystore hot keys (`keys.ts`) |
| `src/ops/` | `/healthz` + `/readyz` probes, ops alerts (deduped, log-only unless `ALERTS_ARMED=1`), monitors |
| `src/client/claimPage.ts` | Browser claim flow (fragment read + wipe, chain-rendered details, sign, relay) |
| `src/abi/` | ABIs generated from the Solidity sources (`contracts/tools/solcjs-compile.mjs --abi-ts-out`) |
| `scripts/server/` | Server scripts for one Ubuntu 24.04 VPS: provision, deploy with rollback, systemd units, Caddy, backups; see its `README.md` |
| `scripts/print-vectors.ts` | Prints the parity vectors asserted by `contracts/test/Vectors.t.sol` |

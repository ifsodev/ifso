# IFSO services

Bun · Hono · tRPC v11 · Drizzle (Postgres/Timescale) · BullMQ (Redis) · viem · grammY.

```bash
docker compose -f ../docker-compose.yml up -d      # postgres + redis
cp .env.example .env && bun install
bun run db:migrate                                  # applies drizzle/0000_init.sql
bun run api      # Hono: /trpc/*, /tg/webhook, /q/:specHash.json, /healthz
bun run worker   # keeper (30 s), price watcher (15 s), resolver (60 s), indexer (5 s), notifier
bun run bot      # long polling for dev (production: set TELEGRAM_WEBHOOK_SECRET and use the webhook route)
bun test         # 111 tests: parser, links + claim signatures, claim relay, typed-data parity, TS<->Solidity
                 # vectors, price evaluation edge cases, outcome agreement, builder, API smoke, banned words
bunx tsc --noEmit
```

| Path | What |
|---|---|
| `src/core/` | Pure logic shared by API, bot, web app: types, condition hashing, EIP-712, links, parser, price mirror, outcome agreement, builder, money, geo, **copy.ts (every user-facing string)** |
| `src/api/` | tRPC router, Hono app, claim/accept relay, fixtures lookup, rate limiting |
| `src/bot/` | Telegram bot (commands -> preview -> URL button to the web app) |
| `src/workers/` | keeper, price watcher, round history, Pyth fetch, outcome resolver, indexer, notifier, BullMQ queues |
| `src/sources/` | The Odds API, TheSportsDB, Polymarket (Gamma + Polygon CTF), Hyperliquid HIP-4 (phase 2) |
| `src/client/claimPage.ts` | Browser claim flow (fragment read + wipe, chain-rendered details, sign, relay) |
| `src/abi/` | ABIs generated from the Solidity sources (`contracts/tools/solcjs-compile.mjs --abi-ts-out`) |
| `scripts/print-vectors.ts` | Prints the parity vectors asserted by `contracts/test/Vectors.t.sol` |

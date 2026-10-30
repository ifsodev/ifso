# IFSO — conditional money on Robinhood Chain

USDG that sits in a non-custodial escrow and unlocks only if a condition is met (a date, a stock price, a match
result or prediction-market resolution, both parties' OK, or a referee). If it isn't met by expiry, anyone can
send it back. Claim links, a Telegram bot and a web app on top.

```
contracts/   Foundry project (Solidity 0.8.28, dependency-free) — escrow, evaluator, outcome resolver, fee router, mocks, tests, deploy script
app/         Bun + Hono + tRPC + Drizzle + BullMQ + viem + grammY — API, bot, keeper, price watcher, resolver, indexer, notifier
```

Status: launch build, 2026-10-25. Working name (name check incomplete). See the Overview / Backend docs for
the spec, red team and milestones.

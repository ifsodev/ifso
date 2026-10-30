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

## Contracts

Solidity 0.8.28, Foundry 1.8.4, no external dependencies, not upgradeable. Details in `contracts/README.md`.

| Contract | Role |
|---|---|
| `IfsoEscrow` | Holds USDG until the condition decides: release to the recipient, return to the sender, or each side refunded. Anyone can refund after expiry. Launch cap: 1,000 USDG per side (`maxAmount`). |
| `IfsoConditionEvaluator` | TIME, PRICE (Chainlink round proofs, Pyth off by default) and OUTCOME conditions; registry for new payments only |
| `IfsoOutcomeResolver` | Bonded results with a 2 h dispute window and a fallback panel; panel silence means VOID |
| `FeeRouter` | Splits flat creation fees 80 / 10 / 5 / 5 |

```bash
cd contracts
forge test                                                   # unit, fuzz, quick invariants
FOUNDRY_PROFILE=invariant forge test --match-test invariant  # 10,000 runs x depth 50
```

Security: `SECURITY.md` (reporting, owner powers, accepted risks), `contracts/THREAT-MODEL.md`,
`contracts/INVARIANTS.md`. Slither findings and their reasons: `contracts/slither.allow`.

## Deployment

| Network | Chain id | Status |
|---|---|---|
| Robinhood Chain | 4663 | not deployed |
| Robinhood Chain testnet | 46630 | not deployed |

Addresses, deploy block, transaction hashes, constructor arguments and the commit of every deployment are recorded
in `contracts/deployments/<chainid>.json`. The deploy script reads no private key (it signs with
`forge script --account <keystore>` or `--ledger`), refuses to run on 4663 or 46630 unless `IFSO_ARMED=1` and
`contracts/.armed-<chainid>` both exist, hands every contract to the owner multisig and asserts the result.
After a deploy: `forge script script/PostDeployCheck.s.sol --rpc-url <rpc>` re-checks it and
`bash script/verify-sourcify.sh <chainid>` publishes the source on Sourcify. A local rehearsal on anvil:
`bash script/local-deploy.sh <port>`.

License: MIT.


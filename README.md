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

## Getting your money back without the website

The contracts do not depend on the website, the Telegram bot or any Ifso server. If those are gone, your money is still
in the escrow contract and you can get it out yourself. You need your payment number (the id) and a wallet that holds a
little ETH for gas on Robinhood Chain. The escrow address for each network is in `contracts/deployments/<chainid>.json`
(chain 4663 is Robinhood Chain), and its verified source is on Sourcify and the block explorer.

Which function to call:

| Situation | Function | Who can call it |
|---|---|---|
| The expiry time has passed and nothing decided the payment | `refund(id, senderAlt, counterAlt)` | Anyone. The money always goes to the sender's refund address (or the alternate one if you pass `true`). |
| A date payment whose date has passed | `settle(id, 0x, false)` | Anyone |
| A price payment after its deadline | `settle(id, proof, false)`, where the proof is the price round number | Anyone (the CLI below builds the proof) |
| You are the sender and the payment was marked cancellable (or a challenge nobody accepted) | `cancel(id)` | The sender |
| You received a claim link | `claim(id, yourAddress, signature)` | Anyone (the signature fixes the recipient) |

### With the block explorer (no software)

1. Open the escrow address on the Robinhood Chain explorer (Blockscout) and choose the Contract tab, then Write contract.
2. Connect your wallet.
3. For a refund, open `refund`, enter the id as a number, leave `senderAlt` and `counterAlt` as `false`, and send. If the
   explorer says the call would fail, the expiry has not passed yet: check `getEscrow(id)` under Read contract
   (`expiry` is a Unix time, `status` 1 means open).
4. For `cancel` and `settle` for a date payment (proof `0x`), the same steps apply.

Price payments and claim links need a proof or a signature that is awkward to produce by hand. Use the command line below.

### With the command line (needs only Bun and a public RPC)

```bash
cd app && bun install
bun scripts/ifso-cli.ts status <id>                                  # what state is it in, when can it be refunded
bun scripts/ifso-cli.ts refund <id> [--alt-sender] [--alt-counter]   # after expiry
bun scripts/ifso-cli.ts settle <id>                                  # date, price or result payments: builds the proof
bun scripts/ifso-cli.ts claim <id> '<claim link>' --recipient <your address>
bun scripts/ifso-cli.ts list --sender <your address>                 # your payments, read from chain logs
```

The tool uses `https://rpc.mainnet.chain.robinhood.com` by default (`--rpc <url>` to change it) and reads the escrow
address from `contracts/deployments/<chainid>.json` (or pass `--escrow <address>`). It needs no database, no Redis and no
Ifso server. It never holds a key and never sends anything: it checks the call with a dry run, then prints the
`to`, `data` and `value` plus a ready `cast send` line (Foundry) that you run with your own keystore or Ledger, for example
`cast send <escrow> "refund(uint256,bool,bool)" <id> false false --rpc-url <rpc> --keystore <file>`. Add `--json` for
machine-readable output. Claim links keep their secret after the `#`; the tool uses it on your computer only and never
prints it.

License: MIT.


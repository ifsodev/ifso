# Ifso

Ifso holds USDG in a non-custodial escrow contract on Robinhood Chain and sends it to the recipient only when a
condition is met: a date, a price, a match result or market resolution, both sides agreeing, or a referee's decision.
If the condition is not met by the expiry time, anyone can send the money back to the sender. Claim links, a Telegram
bot and a web API sit on top of the contracts. The contracts do not depend on any of them.

This repository holds the Solidity contracts (`contracts/`), the Bun services (`app/`) and the website (`web/`), which
talks to the API from the visitor's browser.

## Repository map

| Path | What it holds |
|---|---|
| `contracts/` | Foundry project: Solidity 0.8.28, no external dependencies, not upgradeable. Sources, tests (unit, fuzz, invariant, fork), deploy scripts, CI tools, threat model, invariants |
| `app/` | Bun, Hono, tRPC, Drizzle, BullMQ, viem and grammY: API, Telegram bot, keeper, price watcher, outcome resolver, indexer, notifier |
| `web/` | Next.js 16 website: landing pages, dashboard (create, history, approvals, refunds), claim page and wallet-link page, wired to the API through `@ifso/client` |
| `app/src/client/` | `@ifso/client`, a browser package for the website (typed API calls, signing helpers, claim page) |
| `app/scripts/ifso-cli.ts` | Command line tool to read, refund, settle and claim with only an RPC (see the last section) |
| `app/scripts/server/` | Scripts for one Ubuntu server: provision, deploy with rollback, systemd units, Caddy, backups |
| `app/scripts/release/` | The release runner for the 72 hourly tech updates: install, arming, pipeline with rollback, preflight, sandbox proof; see its `README.md` |
| `FRONTEND.md` | Integration guide for the website: every API call, the signing steps and the copy rules |
| `SECURITY.md` | Reporting, scope, trust assumptions, owner powers, accepted risks, review history |
| `CHANGELOG.md` | What changed, newest first |
| `.github/`, `.githooks/` | CI workflows and the pre-commit checks |

## Contracts

| Contract | What it does |
|---|---|
| `IfsoEscrow` | Holds USDG until the condition decides: release to the recipient, return to the sender, or return each side its own amount. Creation by allowance, EIP-2612 permit, EIP-3009 authorisation or batch. Anyone can refund after expiry, and refunds are never paused |
| `IfsoConditionEvaluator` | Checks TIME, PRICE (Chainlink round proofs, Pyth adapter off by default) and OUTCOME conditions. Keeps the registry of feeds and resolvers; changes to it apply to new payments only |
| `IfsoOutcomeResolver` | Bonded results with a 2 hour dispute window and a fallback panel. If the panel stays silent the question is VOID and each side gets its own money back |
| `FeeRouter` | Splits the flat creation fees 80 / 10 / 5 / 5 between work, treasury, perks and burn |

## Networks

| Network | Use | Chain id |
|---|---|---|
| Robinhood Chain | Production (addresses in Deployment below) | 4663 |
| Robinhood Chain testnet | Rehearsal before production | 46630 |
| Local anvil | Tests and rehearsals only | 31337 |

The token is USDG (6 decimals). Chain facts used by the code are re-checked on chain before every deploy.

## Setup

Requirements: Foundry 1.8.4, Bun 1.4 or later, Docker (for the local Postgres 16 and Redis 7), and optionally Halmos and
Slither for the extra checks in CI.

```bash
git clone <this repository> && cd <this repository>
docker compose up -d                       # Postgres on 5442, Redis on 6389
cd app && cp .env.example .env && bun install
bun run db:migrate
bun run api                                # HTTP API
bun run worker                             # keeper, price watcher, resolver, indexer, notifier
bun run bot                                # Telegram bot with long polling, for local work
```

Every setting is documented in `app/.env.example`. Hot keys (relayer, keeper, resolver) are encrypted keystores with a
password file each; a raw private key in the environment is accepted only on a local chain.

## Tests

| Suite | Command | Covers |
|---|---|---|
| Contracts | `cd contracts && forge test` | Unit, fuzz and quick invariant tests |
| Invariants | `FOUNDRY_PROFILE=invariant forge test --match-test invariant` | 10,000 runs at depth 50 |
| Fork | `RHC_FORK_RPC=<rpc> forge test --match-path 'test/fork/*'` | Real USDG, Chainlink and Stock Token state; skipped without the variable |
| App | `cd app && bun test` | Parser, builder, signatures, relay, API, bot copy, keeper, price watcher and indexer on a private anvil |
| Types | `cd app && bunx tsc --noEmit` | Type check |
| Extra checks in CI | See `.github/workflows/` | Format, size limit, NatSpec, owner powers listed in `SECURITY.md`, Slither allowlist, Semgrep on `app/` (own rules, exact-match allowlist), mutation score, Halmos proofs, coverage, secret scan, banned-word copy test |

## Trust assumptions and owner powers

Short version; the full table, scope and accepted risks are in `SECURITY.md`.

| Party | Can | Cannot |
|---|---|---|
| Owner multisig (2 of 3) | Set creation and resolver fees (each at most 5 USDG), pause new payments, set or remove the launch cap, choose which feeds and resolvers new payments may use, replace the panel after a 48 hour delay | Move, redirect or freeze escrowed USDG, or stop refunds, claims and decisions |
| Panel multisig | Decide disputed outcome questions within 72 hours | Touch any other payment. Silence means VOID |
| Resolver service | Register questions and propose results with a bond that anyone can dispute | Hold user funds |
| Referee (chosen per payment) | Release to the recipient or return to the sender | Anything else |
| USDG issuer | Freeze any address, including the escrow | Outside the control of this project; stated on every create and claim page |

The contracts have not had an external audit. They have had internal reviews, listed in `SECURITY.md`.

## Limits

| Limit | Value |
|---|---|
| Launch cap per side of a payment | 1,000 USDG (`maxAmount`, new payments only; exits never depend on it) |
| Creation fee and resolver fee | At most 5 USDG each (hard cap in the contract) |
| Outcome dispute window | 2 hours; panel decision window 72 hours |
| Panel change delay | 48 hours |
| Contract size | Below 24,576 bytes each |
| Batch plans | Up to 5,000 rows, with per-level limits described in `FRONTEND.md` |

## Reporting a vulnerability

Follow `SECURITY.md`. Please do not open a public issue for a vulnerability and do not test against live deployments.

## Deployment

| Network | Chain id | Status |
|---|---|---|
| Robinhood Chain | 4663 | not deployed |
| Robinhood Chain testnet | 46630 | rehearsal deployment v2 (commit 2cd783d), escrow `0x154Fb83621180f9Dfe80EC3382107C864e79626F` (Sourcify match on all 4 contracts; test tokens only) |

Addresses, deploy block, transaction hashes, constructor arguments and the commit of every deployment are recorded
in `contracts/deployments/<chainid>.json` (today only `46630.json`, the testnet; the site keeps an equal copy in
`web/src/config/deployments/`, made by `bash web/scripts/sync-deployments.sh` and checked by a test). The deploy script reads no private key (it signs with
`forge script --account <keystore>` or `--ledger`), refuses to run on 4663 or 46630 unless `IFSO_ARMED=1` and
`contracts/.armed-<chainid>` both exist, hands every contract to the owner multisig and asserts the result.
After a deploy: `forge script script/PostDeployCheck.s.sol --rpc-url <rpc>` re-checks it and
`bash script/verify-sourcify.sh <chainid>` publishes the source on Sourcify. A local rehearsal on anvil:
`bash script/local-deploy.sh <port>`.

## Getting your money back without the website

The contracts do not depend on the website, the Telegram bot or any Ifso server. If those are gone, your money is still
in the escrow contract and you can get it out yourself. You need your payment number (the id) and a wallet that holds a
little ETH for gas on Robinhood Chain. The escrow address for each deployed network is in `contracts/deployments/<chainid>.json`
and in the Deployment table above (chain 4663 is Robinhood Chain; it has no file until it is deployed), and its verified
source is on Sourcify and the block explorer.

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
bun scripts/ifso-cli.ts claim <id> --link-file - --recipient <your address>   # paste the claim link, then Ctrl-D
bun scripts/ifso-cli.ts claim-void <id> [--side sender|counter]     # a voided challenge side that is still held
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


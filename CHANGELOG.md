# Changelog

All notable changes to this repository are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). The project has not had a tagged release yet; everything below
is under Unreleased and is grouped by area. Dates are the commit dates (UTC).

## [Unreleased]

### Added
- 2026-10-30: Smart contracts for conditional USDG payments: `IfsoEscrow`, `IfsoConditionEvaluator`,
  `IfsoOutcomeResolver` and `FeeRouter`. Conditions are TIME, PRICE (Chainlink or Pyth, at a deadline or on touch),
  APPROVE (both parties or a named referee) and OUTCOME (a bonded, disputable result).
- 2026-10-30: One-sided payments and invite-only two-sided challenges, claim links, gasless create and accept (EIP-3009),
  relayed decisions and refund redirects (EIP-712, EOA or EIP-1271 signers), flat creation and resolver fees capped at
  5 USDG each, and a per-escrow launch cap on new entries.
- 2026-10-30: Deploy script that is keyless, refuses real chains unless armed, writes a deployment record, asserts the
  launch cap, a real Safe owner and Pyth off, and publishes source to Sourcify.
- 2026-10-30: Application in `app/`: typed-data builder and parser, API, keeper, price watcher, indexer, outcome resolver
  workers, Telegram bot flow, per-role environment, RPC fallback and health probes, and `ifso-cli` to refund, settle and
  claim without the website, bot or server.
- 2026-10-30: Handler-based invariant suite (10,000 runs x depth 50 in CI), fork proofs against Robinhood Chain mainnet,
  recorded Chainlink and Pyth fixtures, and gas snapshot.
- 2026-10-30: Server provisioning, deploy-with-rollback, systemd units, Caddy and backup scripts under `app/scripts/server`.
- 2026-10-30: SECURITY.md, threat model, invariants document, MIT license and a deployment README.
- 2026-10-30: Continuous integration: formatting, build and size gate, NatSpec gate, README-vs-deployments check,
  owner-power table check, tests, gas snapshot, local deploy on anvil, invariants, Slither with an exact-match allowlist,
  and app type-check and tests. Every action is pinned by full commit sha.
- 2026-10-30: Audit evidence under `.audit-grade/`: mutation score with a mutant for every round-1 finding, Halmos
  symbolic proofs of the comparison, fee and cap arithmetic, coverage summary, a view-equals-execution test, and CI jobs
  for each, plus a secret scan and a check that every action and image is pinned.

### Changed
- 2026-10-30: Renamed `services/` to `app/` to match the repository layout.
- 2026-10-30: Applied `forge fmt` across the contracts.

### Fixed
- 2026-10-31: Replaying an already used gasless create or accept authorization no longer uses up the signer's relay
  budget: an expired authorization is refused at once and the call is simulated before the per-wallet charge (audit
  M-1).
- 2026-10-31: Football questions are planned only when both result sources have the match, and another address's
  proposal that a final source contradicts (with no final source backing it) is disputed at once (audit M-2).
- 2026-10-31: Outcome payments on a question that is not final yet step aside in the keeper, so they cannot hide the
  payments behind them (audit M-3).
- 2026-10-31: A payment request from the bot can only be built and sent by its owner, never after it was sent or
  expired (audit L-1).
- 2026-10-31: The remaining public reads (build, escrow, mine, question, question specs, readiness) share the
  per-network read budget; readiness answers from a 5 s cache with short reasons; the user counter runs one scan a
  minute whatever date is asked (audit L-2).
- 2026-10-31: The browser package can check a build answer against what the user asked for (amount, recipient or
  claim link, referee, condition, deadline) before anything is signed (audit L-3).
- 2026-10-31: Keeper back-off counts waits and failures separately, so a payment that waited through a hold window is
  retried 2 minutes after its first failed send, not 6 hours (audit L-4).
- 2026-10-31: The resolver service no longer disputes another address's proposal just because its sources cannot
  confirm it yet: contradicted proposals are disputed at once, unconfirmed ones are re-checked every tick and disputed
  only in a last-call slot within a bond budget that keeps one bond spare, largest payments first, with a page to a
  human over budget and an alert when a last-call dispute is lost (round 3, H1).
- 2026-10-31: Polymarket questions resolve no earlier than the market's end date plus 24 hours.
- 2026-10-31: The relayed-change cap per payment counts each signer separately, and closing decisions are never capped,
  so one party cannot use up the other party's gasless decision (round 3, M1).
- 2026-10-31: `/stats` is computed once a minute, and unauthenticated reads that touch the database or RPC share one
  budget per client network; `feeFor` is cached (round 3, L1).
- 2026-10-31: Payments on a stock token with an announced multiplier change that cannot be settled yet step aside on a
  short back-off, and at most 50 of them are looked at per pass, so they cannot hide other payments (round 3, L2).
- 2026-10-31: The wallet-link message names the site and the time the code expires (round 3, I1).
- 2026-10-30: Challenges on a price at a deadline can no longer be accepted once the deciding price may already be
  published (`acceptBy + maxStale` must be before the deadline), and two-sided TOUCH challenges are refused (review
  round 1, findings M1 and M2).
- 2026-10-30: An OUTCOME expiry must leave room for the dispute window, the full panel window and a settle margin, so a
  losing side cannot dispute once and wait for the escrow to expire into a void (round 1, M3).
- 2026-10-30: A void pays each side on its own; a side whose destination cannot receive is left owed and claimable with
  `claimVoid`, and never blocks the other side's refund (round 1, M4).
- 2026-10-30: Repeating an OK or setting the same refund addresses reverts with `NoChange`, so a relayed no-op cannot be
  replayed at the relayer's cost (round 1, M5).
- 2026-10-30: A corporate action that takes effect after the deciding price no longer voids an already decided result;
  multipliers are judged at the price's time (round 1, L1).
- 2026-10-30: The multiplier check fails closed whenever the multiplier in force at the deciding price cannot be proven
  to be the creation snapshot: a corporate action that took effect between the deciding price and the settle now voids,
  as do unreadable schedule fields, so two actions during one payment can no longer hide the first (round 2, L1). A
  change that is announced but still pending at settle keeps a decided result.
- 2026-10-30: The OUTCOME expiry minimum adds `PROPOSAL_GRACE` (2 days) for an honest proposal made late, so a dispute
  after a late proposal still settles before expiry (round 2, L2).
- 2026-10-30: The gas-starvation guard of a void refund covers the USDG proxy's second call frame (`g/16` instead of
  `g/63`), so a starved transfer can never record a payable side as owed (round 2, I1).
- 2026-10-30: Deploy assertions now fail when the launch cap is removed, when the owner is not a real Safe, and when Pyth
  is switched on.

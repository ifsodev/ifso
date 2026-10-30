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
- 2026-10-30: Deploy assertions now fail when the launch cap is removed, when the owner is not a real Safe, and when Pyth
  is switched on.

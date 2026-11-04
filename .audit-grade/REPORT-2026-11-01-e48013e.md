# Ifso: Audit

**Repo:** the private development repo · **Commit:** `e48013e` (2026-10-31) · **Public copy:** not yet synced for this
commit (every point below is earned by files that ship in the public copy) · **Mode:** rescore · **Rubric:** v2 ·
**Previous runs:** rescore on `071fee4` (2026-10-31), 9.6/10, kept in
[REPORT-2026-10-31-071fee4.md](REPORT-2026-10-31-071fee4.md); full on `b9af4a4` (2026-10-31), 8.2/10, kept in
[REPORT-2026-10-31-b9af4a4.md](REPORT-2026-10-31-b9af4a4.md).

Scope (unchanged, file list in [SCOPE.md](SCOPE.md)):
- In scope: `contracts/` (Foundry) and `app/` (API, relayer, bot, keeper, price watcher, resolver, indexer, notifier,
  admin-event monitor, server and release scripts).
- Out of scope: `web/`, the frontend. `web/bunfig.toml` was added in this range; it earns no points.
- Nothing is deployed, so the deployment section scores readiness only.
- Every suite ran in an isolated worktree after `bun install --frozen-lockfile --ignore-scripts`.

Rescore means: every open finding re-checked against the code and its PoC re-run, scans and suites re-run, re-graded.
The five commits since `071fee4` were read as new code. No other new hunting.

## Verdict

**Grade: 9.8 / 10.** No cap binds. The weighted score is 9.85 (was 9.62 → 9.6).

A rescore may show 9+ only with a full or quick run on record within 30 days and a current deploy verdict for anything
live: the full run on `b9af4a4` is from 2026-10-31 and nothing is deployed.

L-6 (the last open finding above Info) is fixed: the original PoC is now refused, and the new hardening case fails
against the old `common.sh` and passes against the new one. The Path items from the last run (Semgrep on the Python
release runner, Bun `minimumReleaseAge`, app coverage, admin-event monitor with signer contacts) were each checked
against the code and re-run here. Two rubric items are still missing: the monitoring item (no oracle-staleness or
large-outflow alert, and the signer contacts are placeholders) and the tag on the audited commit.

## Change since the last run

| Cat | 071fee4 | e48013e | Why |
|---|---|---|---|
| A | 10.0 | 10.0 | `contracts/src` unchanged (`git diff 071fee4 e48013e -- contracts/src` is empty) |
| B | 9.7 | 10.0 | L-6 fixed; no new finding above Info in the new code |
| C | 9.7 | 10.0 | App line coverage 92.4% → 97.4% (mean over `src/`), contracts 97.12%: both over 95% |
| D | 9.0 | 9.0 | Admin-event monitor added (`app/src/workers/adminWatch.ts`), but the monitoring item is all-or-nothing and still lacks oracle-staleness and large-outflow alerts and real signer contacts |
| E | 9.25 | 10.0 | `minimumReleaseAge = 259200` (3 days) in `app/bunfig.toml` and `contracts/bunfig.toml`, with Bun's default script allow-list: two of three install controls |
| F | 9.0 | 10.0 | Semgrep rules now include seven `languages: [python]` rules; the CI scan covers `release.py` and `preflight.py` |
| G | 9.5 | 9.5 | Still no tag on the audited commit |
| **Total** | **9.62 → 9.6** | **9.85 → 9.8** | |

## Findings status

| # | Finding | Status | Re-check (code) | PoC on e48013e |
|---|---|---|---|---|
| M-1 to M-4, L-1 to L-5 | (see the earlier reports) | fixed | Code paths unchanged since `071fee4` except `common.sh` (L-6 below); every regression suite ran green in this run | `auditAG.*` suites pass; `hardening-cases.sh` 21/21 |
| **L-6** | Forged ancestry via a planted graft file | **fixed** | `rgit` now sets `GIT_GRAFT_FILE=/dev/null` and `-c core.commitGraph=false`, next to the existing `GIT_NO_REPLACE_OBJECTS=1` (d062bd5) | Original PoC `L6-graft-downgrade/run.sh` against the new sbin: control exit 1, exploit **exit 1** ("not a descendant of the running revision"). Against the `071fee4` sbin: exploit exit 0, as recorded. `hardening-cases.sh` 21/21 pass on the new sbin; with `HARDENING_SBIN` pointed at the `071fee4` sbin, 19 pass and the 2 L-6 cases fail, as they should |
| Info (new) | Anyone can trigger a `Swept` alert | open | `FeeRouter.sweep` has no owner check, so anyone paying gas can make the monitor post a message. A sweep only moves the router's own balance to its fixed recipients | n/a |

Open Leads and Info rows are unchanged (indexer reads at the latest block, reschedule vs VOID, resolver tick with no time
budget, M-3 delay residual; decision digest does not name the signer, server-signed rollbacks fail safe, `bun audit` 9
high, none judged reachable).

Notes from reading the new code (no deduction):
- `adminWatch.ts` holds no key and only reads logs. It watches every owner or panel event the four contracts declare
  (checked against every `event` in `contracts/src`): both ownership events on each, fees, pause, cap, feeds, Pyth ids,
  outcome sources, creators, bond, panel queued and applied, fee recipients, sweeps. The cursor moves only after every
  contract's logs for the span were read and alerted, so an RPC error re-reads the span; alert keys are `tx hash + log
  index`, so a re-read does not post twice. On its first run it starts at the head, so a change made between deploy
  and the first run is not reported; `PostDeployCheck` covers that window.
- The monitor does not alert on oracle staleness or large outflows. The contracts refuse a stale price (fail closed),
  so no funds are at risk, but the ops chat is not told. The rubric's monitoring item names both, so it is not awarded.
- The SECURITY.md signer table holds roles and placeholders (`_name_`, `_handle_`). It names who may pause, the
  confirmation window and the night cover, but the rubric asks for a runbook with contacts. Signer-chat handles are
  enough; phone numbers and emails can stay private.
- `coverage.gaps.test.ts` asserts behaviour (refusal before gas, no key in error text, JSON-RPC payout parsing), not
  snapshots. The lowest files are `client/claimPage.ts` 61.5% and `db/migrate.ts` 78.6%.

## Verified this run

| Item | Result |
|---|---|
| Build | `forge build` ok (via `forge test`); `bunx tsc --noEmit` exit 0 |
| Tests | **forge:** 167 passed, 0 failed, 3 skipped (fork tests skip without `RHC_FORK_RPC`), 21 suites. **bun:** 605 pass, 0 fail, 70 files, anvil on port 8775 and a throwaway Postgres cluster running |
| Coverage | App: 97.36% lines, mean over the 70 `src/` files (`bun test --coverage`; the tool's "All files" figure, which also counts `scripts/` and test helpers, is 97.18%). Contracts: 97.12% (`coverage.md`; code unchanged) |
| Invariants, mutation, symbolic | Not re-run: `contracts/src` and the contract tests are unchanged since `071fee4` (500k calls per suite, 129/129 mutants killed, 13 Halmos proofs) |
| Semgrep | `semgrep 1.181.0 --config .github/semgrep/rules.yml app` plus `semgrep-gate.py`: 20 findings, 20 allowlisted with a reason, 0 new, 0 stale. Scanned Python: `lib/release.py`, `lib/preflight.py`, `sandbox/fake_world.py`. No `shell=True`, `eval` or `exec` in the runner |
| Release hardening | `sandbox/hardening-cases.sh`: 21 passed, 0 failed |
| Install controls | `app/bunfig.toml`, `contracts/bunfig.toml`: `[install] minimumReleaseAge = 259200` (seconds = 3 days); CI pins Bun 1.4.4, which reads the key. `bun install --frozen-lockfile --ignore-scripts` still passes in both |
| Secrets | `gitleaks detect --config .github/gitleaks.toml`: no leaks. hygiene_scan: no secrets, no key files, no bidi Unicode, no committed agent configs |
| CI | The GitHub result for e48013e was not observed (not synced). Every job's command above ran locally except Slither (Solidity unchanged) |
| Live check | **Not deployed** (pre-launch) |

## Score

| Cat | Score | Weight | Weighted | Why |
|---|---|---|---|---|
| A | 10.0 | 35% | 3.500 | No finding above Info; code unchanged since the full run's line-by-line read |
| B | 10.0 | 15% | 1.500 | No open Low or above (L-6 fixed; the new row is Info) |
| C | 10.0 | 15% | 1.500 | 1.5 build and tests · **1.5 coverage** (app 97.4%, contracts 97.1%) · 1.0 negative · 1.0 fuzz · 2.0 invariants · 1.0 mutation · 1.0 integration · 0.5 Halmos · 0.5 CI |
| D | 9.0 | 10% | 0.900 | As before. **0 monitoring** (all-or-nothing): role-change and pause alerts (`adminWatch.ts`, `test/adminWatch.test.ts`, 6 tests) and keeper-lag and low-balance alerts (`ops/monitors.ts`) are present; oracle-staleness and large-outflow alerts are not, and the SECURITY.md contacts are placeholders |
| E | 10.0 | 5% | 0.500 | 2.0 lockfiles · 1.5 pins · 2.5 advisories (none reachable) · **1.5 install controls** (Bun default script allow-list + `minimumReleaseAge`) · 1.0 vendored · 0.5 submodules · 1.0 toolchains |
| F | 10.0 | 10% | 1.000 | 3.0 secrets · 0.5 env · 1.5 CI tests · **1.0 static analysis** (Slither for Solidity; Semgrep with TS and Python rules for `app/`) · 1.5 Actions hardened · 1.0 LICENSE and SECURITY.md · 1.0 toolchain pins · 0.5 dev environment |
| G | 9.5 | 10% | 0.950 | **0 audit readiness:** SCOPE.md lists the scope, but there is no tag on the audited commit |
| **Total** | | | **9.85 → 9.8** | No cap: no open Critical, High or Medium; full run within 30 days; nothing live |

**Independent check:** a fresh agent recomputed 9.85 against the draft's 9.95. Adopted: D monitoring 1.0 → 0, because the rubric item is all-or-nothing and names oracle staleness and large outflows, and the contacts are placeholders. It could not refute the L-6 fix: `.git/shallow` can only remove parents, alternates add objects but not ancestry, and repo-local config cannot override the pinned `-c` keys. `verify_signed` re-checks every first-parent commit in a root-owned bare repo either way. It found nothing Low or above in `adminWatch.ts` and agreed the `Swept` row is Info. Spot-checks confirmed: E install controls 1.5, F static analysis 1.0, C coverage 1.5 (`coverage.gaps.test.ts` asserts behaviour).

## Path to 9.9+ (ranked by points per hour)

| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | Tag the audited commit (for example `audit-2026-11-01`, or on the public-copy commit) | S | +0.05 | 9.9 |
| 2 | Oracle-staleness alert (feed `updatedAt` older than its heartbeat, Pyth publish time too old) and a large-outflow alert (one `Released`/`Returned` above a set amount, or total per hour) in `ops/monitors.ts`, each with a test; fill the SECURITY.md signer table with names and signer-chat handles | M | +0.10 | 10.0 |

**No points, still worth doing before mainnet:**
- Bump hono, drizzle-orm, @trpc/server and zod past their advisories.
- Settle the four Leads with the tests named in the full report.
- Run the deploy through `deploy-mainnet.sh`, then `PostDeployCheck` with `REQUIRE_HANDED_OVER=1`, then audit-grade
  `verify`. Until `verify` passes, any live deployment caps the grade at 7.0.

## Paste-ready prompt for the dev

```
Read .audit-grade/REPORT.md (rescore of e48013e, 9.8/10). Ask the owner to tag the audited commit
(audit-2026-11-01) and fill the SECURITY.md signer table (names and signer-chat handles). In a fresh worktree: add an
oracle-staleness alert and a large-outflow alert to app/src/ops/monitors.ts, each with a test that fails first; bump hono, drizzle-orm, @trpc/server and zod and re-run
bun audit. One signed conventional commit each. Never touch private keys or send a transaction to a real chain. Run
forge test, IFSO_TEST_ANVIL_PORT=<free port> bun test and bunx tsc --noEmit before each push.
```

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

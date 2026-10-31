# Ifso: Audit

**Repo:** the private development repo · **Commit:** `071fee4` (2026-10-31) · **Public copy:** not yet synced for this
commit (the owner syncs it; every point below is earned by files that ship in the public copy) · **Mode:** rescore ·
**Rubric:** v2 · **Previous run:** full on `b9af4a4` (2026-10-31), 8.2/10, kept unchanged in
[REPORT-2026-10-31-b9af4a4.md](REPORT-2026-10-31-b9af4a4.md).

Scope (unchanged, file list with blob ids in [SCOPE.md](SCOPE.md)):
- In scope: `contracts/` (Foundry) and `app/` (API, relayer, bot, keeper, price watcher, resolver, indexer, notifier,
  server and release scripts).
- Out of scope: `web/`, the frontend. The L-3 fix touches `web/src/lib/ifso/create.ts`; it was read only to confirm the
  page passes what the user asked for into the client check, and earns no points.
- Nothing is deployed, so the deployment section scores readiness only.
- Every suite ran in an isolated worktree after `bun install --frozen-lockfile --ignore-scripts`.

Rescore means: every open finding re-checked against the code and its PoC re-run (it must now fail to exploit), scans and
suites re-run, re-graded. Each fix diff was also read as new code (S-3); that is where L-6 comes from. No other new hunting.

## Verdict

**Grade: 9.6 / 10.** No cap binds. The weighted score is 9.62 (was 8.27 → 8.2).

The rubric allows a rescore to show 9+ only when a full or quick run is on record within 30 days and anything live has a
current deploy verdict: the full run on `b9af4a4` is from 2026-10-31 (today) and nothing is deployed.

All four Mediums and all five Lows from the full run are fixed, each with a regression test that ran green here, and each
original PoC now fails to exploit. The resolver and FeeRouter now have 500,000-call invariant suites, Semgrep runs on
`app/` in CI (TypeScript rules only, so the Python release runner still has no analyser), the contracts package has a
lockfile, and every vendored helper names its origin.

One new Low: the M-4 fix moved signature checks into a root-owned scratch repo, but the ancestry checks still read the
release user's clone, and git honours a `.git/info/grafts` file planted there. A compromised release user can therefore
get an older owner-signed revision accepted (a downgrade). No root, no unsigned code.

## Change since the last run

| Cat | b9af4a4 | 071fee4 | Why |
|---|---|---|---|
| A | 10.0 | 10.0 | `contracts/src` changed only by comment headers (12 files, 29 added comment lines) |
| B | 3.7 | 9.7 | 4 Mediums and 5 Lows fixed; 1 new Low (L-6) |
| C | 7.7 | 9.7 | Invariant suites for IfsoOutcomeResolver and FeeRouter, 500k calls each |
| D | 9.0 | 9.0 | PostDeployCheck now compares bytecode and has a handed-over mode (already scored pre-launch); still no admin-event monitoring |
| E | 6.25 | 9.25 | `contracts/bun.lock` committed (Hardhat runner removed); vendored helpers name their origin |
| F | 9.0 | 9.0 | Semgrep job on `app/` now covers TypeScript, but its rules are TS/JS only; the in-scope Python (`app/scripts/release/lib/release.py`, `preflight.py`) has no analyser, and the item needs every stack |
| G | 9.5 | 9.5 | SCOPE.md added, but the audited commit still has no tag (the item needs both) |
| **Total** | **8.27 → 8.2** | **9.62 → 9.6** | |

## Findings status

| # | Finding | Status | Re-check (code) | PoC on 071fee4 |
|---|---|---|---|---|
| M-1 | Relay-budget burn by replaying a used authorization | **fixed** | `relayBudgetVerified` runs `wouldSucceed` (expiry check plus `simulate`) before `signerBudget`, for both `submit` and `accept` (`router.ts`, a8490e1) | Original PoC: both replay tests fail (the decide relays, no "too many requests"). Regression `auditAG.m1.relayReplay.test.ts` passes |
| M-2 | One-source football questions drain the bond float | **fixed** | `planFootballQuestion` and `registerPlanned` refuse a football question without a TheSportsDB id (`FootballRefused`); `classifyForeign` marks a proposal contradicted when a final source contradicts it and none backs it; the resolver passes the reports (f173e66) | The original PoC still passes because it calls internals that skip the fixed entry points (`footballRow`, `classifyForeign` with no reports). Through the real entry points the exploit is refused: `auditAG.m2.singleSource.test.ts` passes. What remains (a source down at last call) is the accepted R3-H1 row, which SECURITY.md now words for two-source questions |
| M-3 | OUTCOME keeper scan starvation | **fixed** | Rows on a non-final question, and rows with no question id, call `noteWait`, and the page grows by the rows stepping aside (`keeper.ts`, e847b9d) | Original PoC fails (victim settled). Regression `auditAG.m3.outcomeStarvation.test.ts` passes |
| M-4 | Release user to root through a planted `gpg.ssh.program` | **fixed** | `safe.directory=*` removed; `rgit` ignores global and system config and blanks program-launching keys; `verify_signed` copies the commit object into a fresh root-owned bare repo and verifies there with `ssh-keygen` pinned (97580f4) | `sandbox/hardening-cases.sh`: 18/18 pass on 071fee4, 8/18 against the `b9af4a4` sbin (the M-4 and L-5 cases fail there, as they should). The planted program never runs. Residual: L-6 |
| L-1 | Intent IDOR | **fixed** | `intentForBuild` checks expiry, state (draft or built) and owner (linked wallet, else first builder); `submit` moves only the builder's own built intent (86b6b92) | `auditAG.l1.intentOwner.test.ts` passes |
| L-2 | Unbudgeted reads | **fixed** | `readBudget` on `build`, `escrow`, `mine`, `question`; `/q/:file` and `/readyz` share the per-network read budget; `/readyz` cached 5 s and returns probe names only; `/stats/users` does one scan per minute whatever `since` is, and clamps it (68d6cce) | `auditAG.l2.readBudget.test.ts` passes |
| L-3 | Client check does not check intent | **fixed** | `verifyBuildAnswer` takes `asked` (amount, recipient or link key, referee, kind, threshold, deadline, cancellable) and refuses a mismatch; the web create page passes it (f5cb7d2, 7e77cf3). The server still lets a `referee` field override a typed one, but a page that passes the typed referee now refuses that answer | `auditAG.l3.verifyIntent.test.ts` passes |
| L-4 | Waits and failures share one back-off counter | **fixed** | Separate `waits` and `fails` counters (8e805d2) | Original PoC fails (retry after the base delay). Regression `auditAG.l4.backoffCounters.test.ts` passes |
| L-5 | Root publishes any file | **fixed** | Notes must be `$RELEASE_HOME/.relnotes-<id>.md`, poster exactly `posters/<tag>.png`; both opened with `O_NOFOLLOW`, size- and type-checked, copied into a root-owned scratch dir first (3afdda2) | `hardening-cases.sh` L-5 cases pass |
| Info | PostDeployCheck self-referential | **fixed** | Hard-coded 4663 constants, runtime bytecode compared with the build (immutables masked), `REQUIRE_HANDED_OVER=1`, `fold-txs.sh` writes tx hashes into the deployments JSON (071fee4); `contracts/test/PostDeployCheck.t.sol` | n/a |
| **L-6** | **New: forged ancestry via a planted graft file** | **open** | See below | `L6-graft-downgrade/run.sh` (PoC bundle): exit 0 with the graft, exit 1 without |

Leads (no deduction): indexer reads `Created` state at the latest block; a rescheduled fixture may resolve instead of
VOID; the resolver tick has no time budget; new, from the independent check: the M-3 residual, where about 30k paid
escrows that expire earlier could delay (not starve) a settlement, and anyone can still call `settle`. Info (unchanged): the `decideBySig` digest does not name the
signer; server-signed rollbacks fail the owner-only `allowed_signers` gate (fails safe); `bun audit` still reports 9 high
(hono, drizzle-orm, @trpc/server, zod), none judged reachable in the full run, versions unchanged, bump them anyway.

Notes from reading the fixes (no deduction):
- M-1: `registerForFundedSender` now runs before the per-wallet charge. A replayed authorization belongs to an escrow that
  already went through, so its question is already registered and this returns early.
- M-3: a waiting OUTCOME row backs off up to 30 min, so settlement can start up to 30 min after a question is final. The
  OUTCOME expiry already includes a settle margin, and anyone can call `settle`.
- L-1: for a bot user with no linked wallet, the first wallet to build an intent owns it. Someone who sees the id in a
  group chat can take it first, but binding the owner's notifications to their address means paying for the payment
  themselves.

### L-6. Low: a graft file planted in the release clone forges the ancestry checks, so an older signed revision can be deployed
- **id:** `supply-chain|app/scripts/release/sbin/common.sh|graft-ancestry-forgery`
- **Location:** `app/scripts/release/sbin/common.sh` (`rgit`), `sbin/ifso-deploy-release` (the `merge-base
  --is-ancestor` and `rev-list` calls).
- **Path:**
  1. The release user owns `$REPO_DIR`, including `.git/info/grafts` and `remote.origin.url`.
  2. `rgit` sets `GIT_NO_REPLACE_OBJECTS=1`, but git 2.56 still honours a graft file under it (it only prints a
     deprecation hint).
  3. The release user plants grafts that make the running revision a root and an older signed commit its child, and
     points `origin` at a repo whose `main` is that older commit.
  4. `--validate <older sha>` passes every check: "on private main", "descendant of the running revision", "1 commit
     ahead", and the signature (it is a genuine owner-signed commit).
  5. `ifso-deploy` checks out that sha from its own clone. The commit is real, so it is there.
- **Trigger:** a compromised `ifso-release` account, the same precondition as M-4.
- **Impact:** a deploy of any owner-signed commit the deploy clone fetched (`deploy.sh` fetches every branch), not only
  an older one: for example a revision from before the M-1 fix, or an unmerged branch, or a migration mismatch
  that takes the service down. No root and no unsigned code. Escrowed funds are not reachable, because the server owns no
  contract.
- **Evidence:** `L6-graft-downgrade/run.sh <sbin>`. The control (no graft) exits 1, which is a refusal. With the graft,
  `ifso-deploy-release --validate` prints "ok: … 1 commit(s) ahead … all signed" and exits 0.
- **Fix:** run the ancestry checks in a root-owned bare mirror that root fetches itself (as recommended for M-4). At
  minimum, add `GIT_GRAFT_FILE=/dev/null` and `-c core.commitGraph=false` to `rgit`. A graft forged that way was refused in
  the PoC (`merge-base` exit 1).
- **Regression test:** add the PoC as a case in `sandbox/hardening-cases.sh`.

## Verified this run

| Item | Result |
|---|---|
| Build | `forge build --sizes` ok (Foundry 1.8.4, solc 0.8.28); `bunx tsc --noEmit` exit 0 |
| Tests | **forge:** 167 passed, 0 failed, 3 skipped (fork tests skip without `RHC_FORK_RPC`), 21 suites. **bun:** 582 pass, 0 fail, 68 files, with the anvil (port 8645) and Postgres suites running |
| Invariants | `FOUNDRY_PROFILE=invariant forge test --match-test invariant`: EscrowInvariants, ResolverInvariants (`balance == bonds`, no double credit, right party credited, states only move forward) and FeeRouterInvariants (conservation, exact split, no stuck dust), each 10,000 runs x 50 = 500,000 calls, 0 reverts, all pass. They use the real resolver and router contracts on the USDG double |
| Coverage | App: 92.4% lines (mean over `src/` files, `bun test --coverage`). Contracts: 97.12% lines (`coverage.md`; `contracts/src` code is unchanged). Combined about 93% |
| Mutation / symbolic | `mutation.md`: 129/129 killed (100%), with resolver and FeeRouter mutants added. `halmos.md`: 13 proved (code unchanged). Neither was re-run here (about 8 min; `contracts/src` code is unchanged) |
| Semgrep | `semgrep 1.181.0 --config .github/semgrep/rules.yml app` plus `semgrep-gate.py`: 8 findings, 8 allowlisted, 0 new, 0 stale. The rules are the repo's own offline rules (96 lines), not a registry ruleset |
| Slither | Not re-run locally (crytic-compile picked the wrong framework). `contracts/src` changed only in comments, and the allowlist is keyed by detector and element, not by line |
| Secrets | `gitleaks detect --config .github/gitleaks.toml` (the CI command): no leaks. Without the config, 20 generic-api-key hits, all public token addresses or test nonces. hygiene_scan: no key files; `.env` ignored; `.env.example` present |
| Dependencies | `bun install --frozen-lockfile --ignore-scripts`: no changes for `app/` and `contracts/`. `bun audit`: 9 high, unchanged (Info) |
| CI | The GitHub result for 071fee4 was not observed in this run (the commit is not synced yet). Every job's command above ran locally except Slither |
| Live check | **Not deployed** (pre-launch) |

## Score

| Cat | Score | Weight | Weighted | Why |
|---|---|---|---|---|
| A | 10.0 | 35% | 3.500 | No finding above Info. Code unchanged since the full run's line-by-line read |
| B | 9.7 | 15% | 1.455 | 10 − 1 open Low (L-6, 0.3) |
| C | 9.7 | 15% | 1.455 | 1.5 build and tests · 1.2 coverage (about 93%, under 95) · 1.0 negative · 1.0 fuzz · **2.0 invariants** (every fund-holding module: escrow, resolver, FeeRouter, 500k calls each) · 1.0 mutation · 1.0 integration (anvil and real Postgres ran) · 0.5 Halmos · 0.5 CI |
| D | 9.0 | 10% | 0.900 | As before. **0 monitoring:** no alert on ownership, pause, cap or feed events, and the runbook names no signer contacts |
| E | 9.25 | 5% | 0.463 | **2.0 lockfiles** (`app/bun.lock`, `contracts/bun.lock`; CI installs `--frozen-lockfile`; Semgrep and Halmos pip installs `--require-hashes`) · 1.5 pins · 2.5 advisories (none reachable) · **0.75 install controls** (Bun's default allow-list only; no `minimumReleaseAge`, no scanner) · **1.0 vendored** (each helper and interface says it is the repo's own implementation, or which spec it re-declares) · 0.5 submodules · 1.0 toolchains |
| F | 9.0 | 10% | 0.900 | 3.0 secrets · 0.5 env · 1.5 CI tests · **0 static analysis:** Slither covers Solidity and Semgrep covers TypeScript (`.github/semgrep/rules.yml`: every rule is `[typescript, javascript]` or `generic`), but nothing analyses the in-scope Python release runner, and the item asks for each stack present · 1.5 Actions hardened · 1.0 LICENSE and SECURITY.md · 1.0 toolchain pins · 0.5 dev environment |
| G | 9.5 | 10% | 0.950 | As before. **0 audit readiness:** SCOPE.md lists the scope, but there is still no tag on the audited commit, and the item needs both |
| **Total** | | | **9.62 → 9.6** | No cap: no open Critical, High or Medium; full run within 30 days; nothing live |

**Independent check:** a fresh agent recomputed 9.62 → 9.6 and upheld the M-1 to M-4 fixes (no bypass found) and L-6 at Low (re-ran the PoC: control exit 1, graft exit 0). It found nothing Medium or above in the fix diff. Adopted: F static analysis 1.0 → 0 (Python in scope, Semgrep rules TS/JS only), which moves the total from 9.72 to 9.62. Also adopted: L-6 is wider than first written: the release user controls `origin`, and `deploy.sh` fetches every branch, so any owner-signed commit on any branch qualifies; the fix must also disable `commit-graph`. Added as a Lead: the M-3 residual, where about 30k paid escrows that expire earlier could delay (not starve) a settlement, and anyone can still `settle`. Spot-checks confirmed: C invariants 2.0 (the agent re-ran both new suites, 500k calls each), E vendored 1.0, E lockfiles 2.0.

## Path to 9+ (ranked by points per hour)

Already above 9.5. What is left:

| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | Semgrep on the Python release runner (`app/scripts/release/lib/*.py`): add Python rules, or the hash-locked `p/python` ruleset vendored offline, under the same allowlist gate | S | +0.10 | 9.72 |
| 2 | Tag the audited commit (`audit-2026-10-31`). SCOPE.md already lists the files | S | +0.05 | 9.77 |
| 3 | L-6: `GIT_GRAFT_FILE=/dev/null` and `-c core.commitGraph=false` in `rgit`, or ancestry checks in a root-owned mirror; add the PoC to `hardening-cases.sh` | S | +0.045 | 9.82 |
| 4 | `bunfig.toml` with `minimumReleaseAge` in `app/` and `contracts/` (and `--ignore-scripts` in CI and deploy) | S | +0.04 | 9.85 |
| 5 | Admin-event monitor (ownership, pause, cap, feed, fee changes on all four contracts) wired into `ops/monitors.ts` alerts, plus signer contacts in the runbook | M | +0.10 | 9.95 |
| 6 | Combined line coverage to 95% (gaps: `api/claim.ts`, `sources/*`, `workers/pyth.ts`, `workers/deps.ts`) | M | +0.045 | 10.0 |

**No points, still worth doing:** bump hono, drizzle-orm, @trpc/server and zod past their advisories. Settle the three
Leads with the tests named in the first report.

**Before mainnet:**
- Run the deploy through `deploy-mainnet.sh` so the tx hashes are folded into the deployments JSON.
- Run `PostDeployCheck` with `REQUIRE_HANDED_OVER=1` after the Safe accepts ownership.
- Run audit-grade `verify` once anything is live. Until it passes, any live deployment caps the grade at 7.0.

## Paste-ready prompt for the dev

```
Read .audit-grade/REPORT.md (rescore of 071fee4, 9.6/10). In a fresh worktree: (0) extend the Semgrep job to the
Python release runner (app/scripts/release/lib) with an offline ruleset under the same allowlist gate; (1) fix L-6 in
app/scripts/release/sbin/common.sh: make rgit ignore grafts and commit-graph (GIT_GRAFT_FILE=/dev/null,
-c core.commitGraph=false), or move the ancestry checks into a root-owned bare mirror root fetches itself; first add the
L-6 PoC as a case in app/scripts/release/sandbox/hardening-cases.sh, see it fail, then fix and see it pass. (2) Add
bunfig.toml with minimumReleaseAge to app/ and contracts/. (3) Add an admin-event monitor for OwnershipTransferred,
Paused/Unpaused, cap, feed and fee events on all four contracts into ops/monitors.ts with a test, and signer contacts in
the runbook. One signed conventional commit each. Never touch private keys or send a transaction to a real chain. Run
forge test, the invariant profile, IFSO_TEST_ANVIL_PORT=<free port> bun test and the hardening cases before each push,
then ask the owner to tag the audited commit and request a rescore.
```

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

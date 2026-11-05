# Ifso: Audit (rescore)

**Repo:** the private development repo · **Commit:** `d6b7a57` (main, 2026-11-05) · **Mode:** rescore · **Rubric:** v2 · **Date:** 2026-11-05 · **Previous run:** rescore on `2522423` (2026-11-05), 9.7, kept in [REPORT-2026-11-05-2522423.md](REPORT-2026-11-05-2522423.md); last full run: `4318745` (2026-11-05), 8.9, in [REPORT-2026-11-05-4318745.md](REPORT-2026-11-05-4318745.md).

Scope unchanged ([SCOPE.md](SCOPE.md)): `contracts/` and `app/`, including `app/scripts/release/` and `app/scripts/server/`; `web/` out of scope. No Ifso contract is on mainnet (the two mainnet Safes exist); testnet 46630 v2 holds test tokens only and was verified against its build of record in [verify-46630-2026-11-05.md](verify-46630-2026-11-05.md). Suites ran in an isolated `git archive` copy after `bun install --frozen-lockfile --ignore-scripts`, one forge run at a time.

## Verdict
**Grade: 9.9 / 10.** No cap binds: no open Critical, High or Medium, a full run within 30 days, nothing deployed on mainnet. Weighted 9.905 (was 9.76). The 40 commits since `2522423` close L-13 and L-14, each now refused or fixed under its own PoC, and fill the SECURITY.md signer contacts, which restores D to 10. One new Low (L-15): the L-13 fix still lets the release user undo an owner-signed pull of a released update, by a revert of the pull or by a fresh cherry-pick of the pulled update. Do I-18 before the next contracts push: `forge fmt` made one mutation mutant stale, so CI goes red until it is refreshed.

## Prior findings
| # | Finding | Status | Evidence (run this time) |
|---|---|---|---|
| L-13 | Trailer rule lets the release user revert or re-apply any owner-signed commit | **fixed** (residual: L-15) | `32b3b52`: root-pinned queue `/etc/ifso-release/queue-pin` (`common.sh` `in_pinned_queue`, `from_queue :153`, `commit_ok :182`, `pin_queue`; arm.sh 2c/5; `ifso-release-pin-queue` is not in sudoers). Previous PoC `poc_rescore_l13_revert_reapply.py`: both cases OK (root accepts) at `2522423`, both FAIL at `d6b7a57` with "not a commit of the pinned queue". Root-only PoC (`poc_rescore2 test_a`, `test_b`): root `--validate` rc=0 at `2522423`, rc=1 at `d6b7a57`. Regression tests `test_l13_*` (4) in `lib/test_release.py` |
| L-14 | Intent squat links the attacker's wallet to the victim's Telegram user | **fixed** | `ba2de8b`: `rememberSender` removed; the only writer of `tg_users.address` is `linkWallet.ts:39` (the signed link flow; `bot/store.ts upsertUser` never sets an address). `test/auditL14.intentSquat.test.ts` copied onto `2522423`: 0 pass, 2 fail; at `d6b7a57`: 2 pass |
| D: signer contacts | SECURITY.md placeholders | **fixed** | `8161a1d`: owner and panel Safes and their signers, reached through the signer chat; backup route: GitHub private vulnerability reporting. Read-only on 4663: owner Safe `0xd216…59d1` and panel Safe `0x1B43…87dE` are each 2 of 3, their owners are exactly the listed addresses with no overlap, no module, no guard, singleton SafeL2 1.4.1 `0x29fc…C762` |
| Info: stale-lock race | check-then-remove | fixed | `0f6c05a`: the lock is moved aside, its inode and mtime compared, git processes re-checked, and the lock put back otherwise; tests `StaleLocks.test_a_lock_replaced_*` and `test_a_git_process_that_starts_during_the_sweep_*`. Residual: a git process that renames its own lock in the instant between the move and the put-back fails once (liveness only) |
| Info: arm-check signers | server key not re-asserted absent | fixed | `c52aa89`: arm.sh step 2b0/5 refuses while the runner's signing key is in `allowed_signers` |
| Info: wall-clock test | `batchPlan.linear` 5 s timeout | fixed | `454d821` (load-proof ratio test) |
| Info: malformed Polymarket link | masked error | fixed | `7f0a344`: `parsePolymarketLink` returns `invalid` on a URIError; `test/polymarketLink.test.ts` |
| Info: testnet record stale | pre-fix build | fixed | `5b2fd3c`, `1501e80`: v2 record (build `2cd783d`); `112a3c2` records the resolver's `feeRouter` arg; verify run: matches |
| Lead: Vercel builds main | branch protection | open (Lead) | not checkable from the repo; the new Vercel READY gate (`2752c1a`) checks deploy state, not who pushed |

## New findings
### L-15. Low: the release user can undo an owner-signed pull of a released queued update, and root deploys it
- location: `app/scripts/release/sbin/common.sh:153-176` (`from_queue`, revert branch), `:182-207` (`commit_ok`, re-apply branch at `:205`); mirrored in `lib/release.py` `from_queue` and `runner_commit_problem`
- path: (1) the runner releases queued update U as cherry-pick L; (2) the OWNER pulls it with a signed `git revert L` on main (P) and deploys P; (3) code running as `ifso-release` makes `git revert P` (server-signed, "This reverts commit P."); (4) root's `from_queue(P)` follows P's trailer to L, which carries a pinned update, so P counts as a rollback and the revert of P as a re-apply. `commit_ok` accepts a re-apply of any earlier rollback, with no running-release check. Second route (found by the independent check): (3') the release user simply runs `git cherry-pick -x` of the original owner-signed queued commit again; the cherry-pick branch (`common.sh:192-198`) asks only "in the pinned queue, owner-signed, same patch", never whether the owner has since pulled it.
- trigger: a compromised release user (unlikely, privileged). impact: production runs an update the owner deliberately took out (for example one found unsafe). It is still only owner-signed code of the pinned queue, never arbitrary code. The release README says a re-apply is accepted "only of such a rollback" (a runner rollback).
- evidence: PoC `poc_rescore2_l13_root_refusal_and_owner_pull.py test_c` on the real install.sh fixture: python mirror `None`, root `--validate` rc=0 ("each owner-signed or a matching runner commit"). Second route: `poc_rescore2_l15_repick.py test_d`, python mirror `None`, root rc=0 (re-run by the auditor).
- fix: close both routes in `commit_ok` and `runner_commit_problem`: (1) a re-apply only of a rollback that is itself a runner commit (when `from_queue(x)` is `remove`, refuse if `owner_signed x`); (2) a cherry-pick of a pinned update is refused when an owner-signed revert in `base..CUR` takes that update out (or: an owner pull re-pins the queue without it). Regression: `test_c` and `test_d` are refused; `test_revert_with_the_inverse_patch_*` and the sandbox retry and re-apply cases stay green.

### Info and leads
- **I-18 stale mutant (CI red on the next contracts push).** `9fe8ce5` (`forge fmt`) split the resolver constructor's `if (...) revert ZeroAddress();` over three lines. Mutant `AM1-ctor-zero` (`contracts/tools/mutants.py:335-336`) no longer finds its text, so `mutation.py` marks it STALE and the CI `mutation` job (and `ci-summary`) fails whenever `contracts/` changes. Checked with the tool's own count rule: 0 of 143 stale at `2522423`, 1 at `d6b7a57`. `ci-local.sh` runs mutation only with `--slow`, so the local gate missed it. Fix: update the `find` text. The recorded 142/142 stays valid because the change is formatting only.
- **I-19 the pin takes the live queue tip.** `pin_queue` pins whatever owner-signed tip `tu-queue` has when root fetches it, after the release user's own arm-check compared the schedule, and root prints only a count. A release user compromised at the moment of arming could pin an owner-signed branch that has abandoned owner commits in its first-parent history. Fix: arm.sh passes the schedule tip the preflight passed, root refuses a different tip, and root prints the pinned subjects.
- **I-22 a `# ` line inside a code block re-opens a private note section (found by the independent check).** `lib/release.py public_release_body` treats any line starting `# ` as the title, so a shell comment such as `# apply` in a fenced block under `## Integration` turns `keep` back on and the rest of that section reaches the public GitHub Release body. Reproduced: the body contained `# apply` and `bun run app/src/secret_path.ts`. Banned words are still filtered; only non-secret integrator text leaks. Fix: track fenced blocks, or take only the first line as the title.
- **I-20 SECURITY.md lines 50-53** still say the mainnet panel multisig is "not created yet". Both mainnet Safes exist (in the table below that line, and on chain).
- **I-21 release runner tests are not in GitHub CI.** `lib/test_release.py` (including the L-13 cases) and the hardening cases run only through `test-local.sh` and the Linux proof; semgrep covers the Python statically.
- **Lead: keeper-lag scan window.** `monitors.ts:94,107,112` looks at the 50 oldest past-deadline rows. More than 50 long-undecidable OUTCOME rows would hide a later real lag. Data on how long questions stay unresolved would settle it.

**Adversarial checks of the new code that found nothing:**
- The L-13 rule refuses a revert of an owner fix, a pick from an unpinned branch, a revert of an older update that is no longer running, and every runner commit when there is no pin file.
- `ifso-release-pin-queue` is root-only (not in sudoers). It refuses a tip that is not owner-signed or that shares no history with main.
- The sudoers file has no argument patterns, and each wrapper refuses anything but `^TU[0-9]{2}$`. Through sudo, `common.sh` ignores `IFSO_RELEASE_CONF`, `IFSO_RELEASE_LIB` and `IFSO_RELEASE_TEST_PATH`.
- The gate's `umask 022` only widens read access to the gate user's own tree.
- The Vercel READY gate fails on ERROR and on timeout; only an API that never answers falls back to alert-only.
- The GitHub Release body keeps only the public sections. A banned word drops the body (title only) and raises an alert.
- The anvil install is pinned by sha256 per architecture and never uses `curl | sh`.
- `DeployBase._checkSigners` refuses shared owner and panel signers, and refuses the deployer, relayer, keeper or resolver hot wallets as signers, on every chain except 46630 and 31337 (`SignerSeparationTest`, 6 tests). An unreadable owner list fails closed.
- `_checkConstructorArgs` takes the input count from the build ABI and fails on missing or extra values.
- keeper-lag counts a row whose probe fails.
- The public guard and gitleaks accept 64-hex values in deployment records only under tx or block hash keys (guard tests 16/16).
- `github.event.before` reaches `ci-changes.sh` through `env:` only, and every new action is pinned by full sha.
- Path filters run everything on PRs, first pushes, rewritten branches, `.github/` changes and unknown paths, and `ci-summary` fails a skipped job whose files changed.

## Verified this run
| Item | Result |
|---|---|
| Tests | forge 189/0/3 (25 suites, default profile) · invariants, profile `invariant` as in CI (10,000 runs x depth 50 = 500,000 calls per suite): 3 suites, 16 invariants, 0 failures (424 s) · bun 749/0/1 (94 files, anvil and Postgres suites included), `tsc --noEmit` clean · release runner unit 71/0, hardening cases 96/0 |
| PoCs | L-13: the old PoC and the root-only PoC are refused at `d6b7a57` and accepted at `2522423` · L-14: 2 fail at `2522423`, 2 pass at `d6b7a57` · L-15: root accepts at `d6b7a57` |
| Coverage | reused (contracts 97.45%, app 97.31%): contract sources changed by formatting only, app sources by one removed function and small guards |
| Mutation | 142/142 recorded (sources changed by formatting only); 1 mutant now stale (I-18) · Halmos: committed result reused |
| Semgrep / gitleaks | 27/27 allowlisted, 0 new, 0 stale (semgrep 1.181.0 on a clone of `d6b7a57`) · gitleaks over 1,325 commits with the repo config: no leaks · public-guard tests 16/16 |
| Slither | reused 42/42 (no semantic change in `contracts/src`; `script/` and `test/` are filtered out of the gate) |
| Mainnet Safes (read-only) | owner and panel are 2 of 3, owners as listed in SECURITY.md, no overlap, no module, no guard |
| Testnet / Mainnet | v2 matches build `2cd783d` (verify run 2026-11-05; `d6b7a57` differs from it only in the formatting of the resolver constructor) / not deployed |

## Score
| Cat | Score | Weight | Weighted | Change and evidence |
|---|---|---|---|---|
| A | 10.0 | 35% | 3.500 | 0: no open on-chain finding |
| B | 9.7 | 15% | 1.455 | +0.3: L-13 and L-14 fixed (+0.6), L-15 open Low (-0.3) |
| C | 10.0 | 15% | 1.500 | 0: suites pass, coverage >= 95%, invariants >= 100k calls, mutation 100%, Halmos, CI on push |
| D | 10.0 | 10% | 1.000 | +1.0: monitoring and incident response now has its signer contacts (SECURITY.md "Signer contacts") |
| E | 10.0 | 5% | 0.500 | 0: lockfiles unchanged, frozen installs, pins |
| F | 10.0 | 10% | 1.000 | 0: gitleaks clean, actions pinned, scanners in CI |
| G | 9.5 | 10% | 0.950 | 0: no tag on the audited commit (-0.5) |
| **Total** | | | **9.905 -> 9.9** | no cap |

**Independent check:** a fresh agent recomputed 9.905 -> 9.9, agreed with every category and with L-15 (Low) and I-18; it found a second L-15 route (re-cherry-pick, adopted into L-15) and I-22 (adopted); its spot-checks of D signer contacts, C invariants (profile `invariant`, 10,000 x 50, ci.yml:109) and F action pins passed; no Medium or above found.

## Path to 10
| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | L-15 fix, both routes (re-apply of an owner-signed rollback; re-pick of an update an owner revert pulled) in `commit_ok` and `runner_commit_problem`; regression: `test_c` and `test_d` are refused | M | +0.045 | 9.95 -> 9.9 |
| 2 | Tag the audited commit at launch (`audit-<date>` on the launch commit) | S | +0.05 | 10.0 |
| - | I-18 (0 points, do it first): refresh mutant `AM1-ctor-zero`, or CI goes red on the next contracts push | S | 0 | |

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

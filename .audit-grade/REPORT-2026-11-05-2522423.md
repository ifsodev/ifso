# Ifso: Audit (rescore)

**Repo:** the private development repo · **Commit:** `2522423` (main, 2026-11-05) · **Mode:** rescore · **Rubric:** v2 · **Date:** 2026-11-05 · **Previous run:** full on `4318745` (2026-11-05), 8.9, kept in [REPORT-2026-11-05-4318745.md](REPORT-2026-11-05-4318745.md); earlier: rescore `97d108d` 9.8, rescore `e48013e` 9.8, rescore `071fee4` 9.6, full `b9af4a4` 8.2.

Scope unchanged ([SCOPE.md](SCOPE.md)): `contracts/` and `app/`, including `app/scripts/release/` and `app/scripts/server/`; `web/` out of scope. Nothing on mainnet; testnet 46630 holds no value. Suites ran in an isolated `git archive` copy after `bun install --frozen-lockfile --ignore-scripts`. Main moved during the run (`bb8bb7f`: testnet v2 record); this report grades `2522423`.

## Verdict
**Grade: 9.7 / 10.** No cap binds: no open Critical, High or Medium, a full run within 30 days, nothing deployed. Weighted 9.76 (was 9.025, capped 8.9). The 35 commits since the full run close M-1, M-2 and L-8 to L-12, each with a regression test. New: L-13 (the M-2 trailer rule still lets the release user revert or re-apply owner-signed commits outside the queue) and L-14 (intent squat links the attacker's wallet to the victim's Telegram user; found by the independent check). D (signer contacts) and G (tag) unchanged.

## Prior findings
| # | Finding | Status | Evidence |
|---|---|---|---|
| M-1 | Free self-dispute | **fixed** | `IfsoOutcomeResolver.sol:204` refuses `msg.sender == q.proposer` (`SelfDispute`); `:236-239` panel winner gets its bond + `floor(bond/2)`, loser's `ceil(bond/2)` forfeited; `:251-254` silence: each side `floor(bond/2)`, rest forfeited; `forwardForfeits` `:269` (pull). Tests `test/pocs/AuditM1SelfDispute.t.sol`, invariants OR1 and OR5, Halmos `check_ResolverDisputeSplit`; keeper pass `keeper.ts:386`. Residual (a large stake pays bond/2 for up to 72 h) accepted in SECURITY.md |
| M-2 | Server key in `allowed_signers` | **fixed** | `install.sh:196-203` removes it; `release.py:423-424` requires an owner-signed queued commit; root `ifso-deploy-release:38-55` with `common.sh commit_ok :140-160` in root's own 0700 repo; runner commits only as same-`patch-id --verbatim` cherry-pick or exact inverse; gate as `ifso-gate` (`release.py:493-500`) from a `git archive` export with `--ignore-scripts` (also `deploy.sh:294`); arm-check refuses without a gate user. Residual: L-13 |
| L-8 | First final kept | **fixed** | `resolver.ts:287-300` `holdLatestFinals`; `test/auditL8.*` |
| L-9 | Typed-sender intent rewrite | **fixed** | `router.ts:410-415`, `submitIntent :221-235`; `test/auditL9.*`. Residual: L-14 |
| L-10 | `verifyBuildAnswer` gaps | **fixed** | `verifyBuild.ts:90-110`; `test/auditL10.*` |
| L-11 | Root follows symlinks | **fixed** | `common.sh:38-63` `rel_read` (O_NOFOLLOW, regular files, size cap) |
| L-12 | Forgeable "on main" | **fixed** | `common.sh:103-116` `root_fetch_main` (pinned URL, own read-only key, pinned GitHub ED25519 host key); arm.sh cross-checks |
| I-13..I-17 | Semgrep, CI Foundry, record, strict times, hygiene | fixed (I-15 partly: at `2522423` the record is the pre-fix build; `5b2fd3c` records the v2 redeploy) | |

## New findings
### L-13. Low: the trailer rule lets the release user revert or re-apply any owner-signed commit, and root deploys it
- location: `common.sh:140-160` (`commit_ok`), `:118-123` (`ensure_commit`); mirror `release.py:352`
- path: code running as `ifso-release` (write deploy key + server signing key) can `git revert F` for any owner-signed F on main, or push any owner-signed E (from any repo signed with the owner key) into its own queue repo and cherry-pick it; root accepts both (ancestor + exact inverse / same patch-id). Neither has to be in the schedule.
- trigger: a compromised release user (unlikely). impact: production loses an owner fix or runs owner-signed code not meant to ship; arbitrary code still refused.
- evidence: PoC `poc_rescore_l13_revert_reapply.py` (real install.sh and `ifso-deploy-release --validate`), root rc=0 both cases; independent check 8/8.
- fix: accept a revert only of X in `cur..sha` or X == `cur`; a cherry-pick only of X on the first-parent chain of an owner-signed queue tip pinned by arm.sh in a root-owned file. Regression: the two PoC cases refuse; sandbox rollback stays green.

### L-14. Low: an intent squat links the attacker's wallet to the victim's Telegram user
- location: `app/src/api/linkWallet.ts:41-45`, `router.ts:208-235`
- path: intent id visible in group buttons; attacker builds with its own sender (owner null), submits its own signed create; `rememberSender` links the attacker's address to the victim's `tgUsers` row; the victim's later intents are refused and notifications follow the attacker until relink.
- trigger: any group member when the victim has no linked wallet (possible). impact: griefing, wrong accounting, no funds. Pre-existing.
- fix: `rememberSender` links only through the explicit link-request flow. Regression: a squatter leaves `tgUsers.address` null.

**Info:** stale-lock check-then-remove race (`release.py:1012`, liveness only); arm-check does not re-assert the server key is absent from `allowed_signers`; `batchPlan.linear.test.ts` 5 s wall-clock fails at load 110+ and under `--coverage`; `decodeURIComponent` on a malformed Polymarket link throws (masked error); Vercel builds `web/` from main which the release user's write key can push to (check branch protection).

**Adversarial checks that found nothing:** bond conservation in every branch (OR1/OR2), the service never disputes its own proposal, forfeits only to the immutable FeeRouter by pull; patch-id changes on mode/rename/empty-file/symlink/binary, merges refused, last trailer only, depth cap 4; every gate step through `gate_shell`, env files 0600, sudoers lets release become gate only; link resolver fails closed; Caddy `trusted_proxies` affects the log only; root's queue fetch maps only into `refs/queue/*`.

## Verified this run
| Item | Result |
|---|---|
| Tests | forge 182/0/3 · bun 717/0/1 (93 files; a run at load 110-155 timed out one wall-clock test, clean re-run green) · runner unit 62, hardening 61/0, sandbox 136/0 |
| Coverage | contracts 97.45% · app 97.31% |
| Invariants | 3 suites x 500,000 calls, 0 failures |
| Mutation | 142/142 · Halmos: committed/CI result reused (sources unchanged) |
| Slither / Semgrep / gitleaks | 42/42 allowlisted · 27/27, 0 stale · clean over 1,294 commits |
| Testnet / Mainnet | pre-fix build at `2522423` (Info) / not deployed |

## Score
| Cat | Score | Weight | Weighted | Change |
|---|---|---|---|---|
| A | 10.0 | 35% | 3.500 | +1.2 |
| B | 9.4 | 15% | 1.410 | +2.1 |
| C | 10.0 | 15% | 1.500 | 0 |
| D | 9.0 | 10% | 0.900 | 0 (signer contacts placeholders) |
| E | 10.0 | 5% | 0.500 | 0 |
| F | 10.0 | 10% | 1.000 | 0 |
| G | 9.5 | 10% | 0.950 | 0 (no tag) |
| **Total** | | | **9.76 -> 9.7** | no cap |

**Independent check:** 9.7; agreed M-1, M-2, L-13; found L-14 (adopted); spot-checks passed.

## Path to 10
| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | Fill the SECURITY.md signer contacts table | S | +0.10 | 9.8 |
| 2 | Tag the audited commit | S | +0.05 | 9.9 |
| 3 | L-13 fix | M | +0.045 | 9.9 |
| 4 | L-14 fix | S | +0.045 | 10.0 |

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

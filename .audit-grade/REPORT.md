# Ifso: Audit

**Repo:** the private development repo · **Commit:** `4318745` (`431874595c48`, main, 2026-11-04 21:00 UTC) · **Public copy:** synced 2026-11-05 (public main f7c79f5) · **Mode:** full · **Rubric:** v2 · **Date:** 2026-11-05 · **Previous runs:** rescore on `97d108d` (2026-11-04), 9.8, kept in [REPORT-2026-11-04-97d108d.md](REPORT-2026-11-04-97d108d.md); rescore on `e48013e` (2026-11-01), 9.8; rescore on `071fee4`, 9.6; full on `b9af4a4` (2026-10-31), 8.2.

Scope (file list in [SCOPE.md](SCOPE.md)):
- In scope: `contracts/` (sources and deploy scripts) and `app/`, including the release runner `app/scripts/release/` (root sudo wrappers) and the server scripts `app/scripts/server/`.
- The skill's 2026-11-04 update does not add `web/`, so `web/` stays out of scope; only its build inside the release gate is looked at, as release-runner behaviour.
- Nothing is on mainnet. The testnet deployment (46630) holds no value: its deploy-verification lane was run as a rehearsal and is not counted as live.
- Every suite ran in an isolated `git archive` copy after `bun install --frozen-lockfile --ignore-scripts`. Static scans read the audit worktree.

## Verdict
**Grade: 8.9 / 10.** The open-Medium cap (8.9) binds. The weighted score is 9.02 (was 9.81 at the 2026-11-04 rescore).

The full run found two Mediums that the rescores could not catch:
- **M-1 (contracts, unchanged since 2026-10-31):** a party can dispute its own outcome proposal, which sends any question to the panel at no bond cost and locks the resolver service out.
- **M-2 (release runner, new in `97d108d..4318745`):** `install.sh` now puts the server's own signing key into the `allowed_signers` file that root checks, so the "owner-signed only" deploy gate no longer holds.

Both fixes are small. Fixing both lifts the cap, and the Path below reaches 10.0.

## Findings

### M-1. Medium: free self-dispute sends any outcome question to the panel
- id: `evm|contracts/src/IfsoOutcomeResolver.sol|self-dispute-free`
- location: `contracts/src/IfsoOutcomeResolver.sol:169` (`propose`), `:188` (`dispute`), `:214-223` (`panelResolve`), `:229-237` (`finalizeTimedOut`)
- path:
  1. At `earliestResolve`, anyone calls `propose` with any outcome (`:169-172`: only state and time are checked). The resolver service proposes on its next 60 s tick and only once two sources agree, so the attacker is first.
  2. The same address calls `dispute` in the same block (`:188-190`). Nothing requires disputer != proposer. State becomes DISPUTED; the service's `propose` and `dispute` both revert `WrongState`.
  3. The bonds always come back to the attacker: panel for the proposal, the pot goes to the proposer; panel against it, the pot goes to the disputer (`:223`); silence, each bond goes back (`:234-235`).
  4. The payment waits up to `panelWindow` (72 h). On panel silence the evaluator reads VOID and the losing side keeps its stake.
- trigger: anyone, normal state. Cost: gas plus 2 x 100 USDG locked up to 72 h, all returned. One float can repeat it on every OUTCOME question.
- impact: the dispute bond no longer deters (`THREAT-MODEL.md:34`, "a losing disputer forfeits it", is false for a self-dispute); any OUTCOME payment can be held up to 72 h and every such question forces a panel decision; the losing side gets a free option on panel silence. No principal is lost. Griefing x likely = Medium. The escrow's expiry minimum (`IfsoConditionEvaluator.sol:161-163`) keeps the delay inside expiry.
- evidence: `contracts/test/pocs/AuditM1SelfDispute.t.sol`, 3/3 pass (attacker made whole when the panel rules against it, payment released 70 h late; panel silence: VOID, the losing sender keeps 20 USDG; control: an independent wrong disputer loses 100 USDG). The independent check re-ran it and agreed.
- fix: on a panel decision the winner gets its own bond plus half the loser's and the other half goes to the FeeRouter (the UMA pattern), so a self-dispute costs bond/2; refuse `msg.sender == q.proposer`; update THREAT-MODEL. Needs a redeploy (testnet first).
- regression test: the PoC asserting `before - _bal(attacker) >= bond / 2`, plus a resolver invariant with proposer == disputer.

### M-2. Medium: the server signing key in `allowed_signers` turns the owner-signature gate off
- id: `supply-chain|app/scripts/release/install.sh|server-key-in-allowed-signers`
- location: `app/scripts/release/install.sh:154-167`, `lib/release.py:354-379` (`apply_commit`), `sbin/ifso-deploy-release:36-47`, `sbin/common.sh:51-63`
- path:
  1. `install.sh:154-167` creates `id_ed25519_signing` as the release user, sets it as the runner's signing key and appends it to `/etc/ifso-release/allowed_signers`. At `97d108d` the key was not added, so server-signed commits failed closed.
  2. A non-fast-forward queued commit is cherry-picked with `commit.gpgsign=true` (`release.py:372`). Only the landed, server-signed commit is checked (`:378`), never the queued commit's own signature.
  3. Root's `ifso-deploy-release` runs `verify_signed` on every first-parent commit against the same file (`:47`), so the server-signed commit passes.
  4. Any code running as `ifso-release` can sign any commit: that user holds the signing key and the private repo's write deploy key (`install.sh:186`), can push to main and call `sudo ifso-deploy-release <sha>`. The gate runs `bun install` without `--ignore-scripts`, plus typecheck, tests and `next build` of queued trees, all as that user.
- trigger: a compromised dependency in the gate, a compromised release user, or any unsigned queued commit. Unlikely.
- impact: arbitrary backend code runs as the service users, reaching the relayer, keeper and resolver keystores (resolver bond float about 500 USDG) and the API that builds what users sign. Undoes the 2026-10-31 M-4 fix. Loss of funds x unlikely = Medium.
- evidence: `python3 -I app/scripts/release/lib/poc_audit_m2_server_key.py`, 3/3 OK, driving the real `apply_commit`, `signature_ok` and `verify_signed` (exploit: an unsigned `eb7783d` landed as `ab1a2ef`, `signature_ok=True`, root rc=0; control: with an owner-only file `apply_commit` raises Fail and root rc=1, "No principal matched"). The independent check re-ran it and agreed.
- fix: (a) root uses an owner-only signers file; a runner-made commit is accepted only when its `cherry picked from` or `This reverts commit` trailer names an owner-signed commit with the same (or inverse) patch-id, or roll back by switching `/opt/ifso/current` instead of a revert commit; (b) `apply_commit` checks the queued `u.sha` against the owner-only file; (c) the gate runs as a user with no access to `~/.ssh`, with `--ignore-scripts`.
- regression test: the PoC as a `test_release.py` case, plus a sandbox hardening case "server-signed commit with no owner-signed source is refused".

### Lows
| # | Finding | Location | Path / impact | Fix |
|---|---|---|---|---|
| L-8 | The L-7 fix keeps the FIRST final read, not the latest | `app/src/workers/resolver.ts:286-299` | The Odds API reads final A, corrects to B, a later read is pending, so A is put back; TheSportsDB reads B, `agree` returns a conflict, nothing is proposed (refund at expiry). A correct foreign proposal can be classed "contradicted" and disputed. Needs an upstream correction. PoC `app/test/auditL8.firstFinalSticks.anvil.test.ts`: 2 pass | Keep the latest final per provider |
| L-9 | The intent owner check uses a typed `sender` (L-1 residual) | `app/src/api/router.ts:198-207,379-383,424-428` | Anyone with the intent id and the owner's address rewrites params and escrowId; the owner's submit no longer matches and `/mine` points at a payment that does not exist. Bookkeeping only. PoC `app/test/auditL9.intentRebuildTypedOwner.test.ts` | Write params only in `submit`, after the signature |
| L-10 | `verifyBuildAnswer` leaves fields unchecked (L-3 residual) | `app/src/client/verifyBuild.ts:22-35,63-75` | refundTo/altRefundTo, op/mode, expiry, acceptBy, stock token and the outcome key/mask are not compared, so a compromised server can get a refund-to-attacker payment signed; the docstring `:41-43` promises otherwise. PoC `app/test/auditL10.verifyBuildGaps.test.ts` | Complete `AskedFor`; require `refundTo` in {0, from} |
| L-11 | The root status wrapper follows release-user symlinks | `app/scripts/release/sbin/ifso-release-status:13,20` | Root runs `head -c 300 PAUSE` and `tail alerts.log`; a planted symlink prints root-only env to an `ifso-ops` operator. Traced by reading | `as_rel` or `O_NOFOLLOW` |
| L-12 | The "on private main" check reads a ref the release user can forge | `sbin/ifso-deploy-release:36-42`; `app/scripts/server/deploy.sh:281-285` | The fetch runs as the release user with its own `.git/config`, and that user can `update-ref` `refs/remotes/origin/main`. So any commit on any branch that passes the signature and descendant checks deploys (with M-2 open, anything; after the M-2 fix, any owner-signed commit off main). Found by the independent check | Root fetches main itself, into a scratch repo, from a URL pinned in paths.conf |

**Info (no deduction):**
- I-13: the semgrep exact-match gate is red at `4318745`: 4 new benign hits in `release.py` (list-argv subprocess calls, urlopen to configured URLs) and 1 stale allowlist line.
- I-14: the app CI job installs no Foundry, so 21 anvil-gated app test files are skipped in CI (`ci.yml:105-116`, `test/helpers/chain.ts:37`).
- I-15: the testnet is live and Sourcify-matched, but `contracts/deployments/46630.json` is not committed, `README.md:109` says "not deployed", and the manifest's `resolverCreator` is the deploy-time key, so `PostDeployCheck` fails until the live creator (the relayer) is written in.
- I-16: `acceptBy <= closeTime` and `earliestResolve >= closeTime` allow an accept and a proposal in the same second (`IfsoConditionEvaluator.sol:153`, `IfsoOutcomeResolver.sol:153`). Use strict inequalities.
- I-17: raw `e.message` reaches callers (`app.ts:73`); the webhook secret is compared with `!==`; `incr` and `expire` are not atomic (`rateLimit.ts:17-18`); the failover text redacts userinfo only (`rpc.ts:44`); `/mine` in a group lists private payments (`bot/store.ts:83`); the alert claim is taken before the send.
- Testnet rehearsal: the owner Safe's signers include the deployer and the former resolver key (threshold 2); the mainnet Safe needs human signers (PRIV-3).
- `setBondAmount` (up to 10,000 USDG, instant) could price the service out of disputing. Privileged (D), noted only.

**Leads (no deduction):** no global relay ceiling (`router.ts:86-137,548`); Odds API quota not tracked (`resolver.ts:260,536`); Vercel builds `web/` from main without a signature gate (check branch protection); TIOCSTI via `runuser` without `--pty` (`common.sh:23`); Chainlink phase migration between deadline and settle (`IfsoConditionEvaluator.sol:286-320`); two allowlisted resolvers would share question ids (`keeper.ts:269-289`); earlier Leads still open (indexer reads at the latest block; reschedule vs VOID; resolver tick has no deadline; Cloudflare own-zone `cf-ipcountry`).

**Fixed since the last report:** L-7 (`eb6d339`; L-8 is a bug in that fix), I-9 (`0103f12`), I-10 (`772df77`), I-11 (`1b8150e`). The Info row `server-key-vs-allowed-signers` became M-2. M-1 to M-4 and L-1 to L-6 of 2026-10-31 are still fixed.

## Hunt items from the 2026-11-04 skill
| Item | Result |
|---|---|
| VAULT-1 | n/a: no ERC-4626 or share-priced pool |
| STALE-1 | The staleness monitor only warns (`monitors.ts:293-335`); contracts never pause on staleness. Feed heartbeats on 4663 measured 2026-11-05 (docs, chain-facts.md) |
| MON-1 | n/a: no worker holds a pause key |
| Off-chain copies of on-chain maths | `feeFor` read fresh; typed data and ids parity-tested |
| Env-driven job lists | n/a: hard-coded (`main.ts:69-74`) |
| Sources answer after close | Gamma single-market ok, CTF ok, TheSportsDB by id ok, Odds API fixed except L-8 |
| Outsider-checkable claims | Nothing announced live; README testnet row wrong (I-15) |
| Outside reviewer rounds | None recorded |
| Pending timelock ops | None (no timelock; `pendingPanel() = 0` on testnet) |

## Verified this run
| Item | Result |
|---|---|
| Tests | forge 167 / 0 / 3 skipped (fork) · bun 670 / 0 (85 files, anvil and Postgres) · tsc 0 · runner unit tests 47 OK |
| Coverage | Contracts 97.39% lines, 77.12% branches · app 97.33% lines |
| Invariants | Escrow, Resolver, FeeRouter: 10,000 x 50 = 500,000 calls each, 0 failures |
| Halmos | 0.3.3, hash-locked: 13 / 13 |
| Mutation | Fresh run: 129 / 129 killed |
| Slither | 0.11.6: 42 findings, 42 allowlisted, 0 new |
| Semgrep | Repo gate red (I-13); registry p/default + p/secrets: 6 benign hits |
| Secrets | gitleaks over 930 commits: clean with the repo config |
| Advisories | `bun audit`: app zod high (unreachable), contracts dev-only |
| CI | SHA-pinned actions, `contents: read`, `persist-credentials: false`, gitleaks, slither, semgrep, halmos, coverage and mutation jobs; app anvil tests skipped (I-14) |
| Testnet 46630 (rehearsal) | `PostDeployCheck` with the manifest as written fails on `resolverCreator` (I-15); with the live creator pinned it passes, with and without `REQUIRE_HANDED_OVER=1`: bytecode of all 4 contracts equals the build (immutables masked), the Safe accepted ownership, the deployer holds no role. Sourcify `match` on all 4. Escrow: owner Safe 2-of-3, `pendingOwner` 0, not paused, cap 1,000 USDG, fee 0.25 USDG. Resolver: bond 100 USDG, `pendingPanel` 0, `isCreator(relayer)` true |
| Mainnet | Not deployed |

## Score
| Cat | Score | Weight | Weighted | Why |
|---|---|---|---|---|
| A | 8.8 | 35% | 3.080 | 10 - 1.2 (M-1) |
| B | 7.3 | 15% | 1.095 | 10 - 1.2 (M-2) - 0.3 x 5 (L-8 to L-12) |
| C | 10.0 | 15% | 1.500 | tests, coverage >= 95%, negative, fuzz, invariants 500k on all 3 fund-holding modules, mutation 129/129, anvil + Postgres integration, Halmos, CI |
| D | 9.0 | 10% | 0.900 | 0 for monitoring: signer contacts are placeholders |
| E | 10.0 | 5% | 0.500 | frozen lockfiles, exact pins, nothing reachable, minimumReleaseAge |
| F | 10.0 | 10% | 1.000 | (gate red is I-13) |
| G | 9.5 | 10% | 0.950 | no tag on the audited commit |
| **Total** | | | **9.025** | **Cap 8.9 (M-1, M-2) -> 8.9** |

**Change since the 97d108d rescore:** A 10.0 -> 8.8 · B 9.7 -> 7.3 · C to G unchanged.

**Independent check:** a fresh agent recomputed 9.07 (8.9 capped), re-ran forge, invariants, bun, tsc and the M-2, L-9 and L-10 PoCs, agreed with M-1, M-2 and the Lows, and found L-12 (adopted: B 7.6 -> 7.3).

## Path to 10 (ranked by final-grade points per hour)
| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | M-2: owner-only signers for root and the queued commit; trailer-matched runner commits (or directory-switch rollback); gate as a user without `~/.ssh` and with `--ignore-scripts` | M | with #2 +0.70 | 8.9 |
| 2 | M-1: split the losing bond (half to FeeRouter), refuse self-dispute, update THREAT-MODEL, redeploy testnet | M | +0.70 (cap lifted) | 9.6 |
| 3 | Fill the SECURITY.md signer contacts table | S | +0.10 | 9.7 |
| 4 | Tag the audited commit | S | +0.05 | 9.7 |
| 5 | L-8: latest final per provider | S | +0.045 | 9.8 |
| 6 | L-10: complete `AskedFor` | S | +0.045 | 9.8 |
| 7 | L-11: `as_rel` or `O_NOFOLLOW` | S | +0.045 | 9.9 |
| 8 | L-12: root fetches main itself | S | +0.045 | 9.9 |
| 9 | L-9: intent params only in `submit` | M | +0.045 | 10.0 |

No points, still worth doing: I-13 semgrep allowlist; I-14 Foundry in the app CI job; I-15 commit `46630.json` and fix the README row; human signers on the mainnet Safe; `--ignore-scripts` in deploy and the gate; the Leads.

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

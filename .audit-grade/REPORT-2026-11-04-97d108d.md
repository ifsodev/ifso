# Ifso: Audit

**Repo:** the private development repo · **Commit:** `97d108d` (branch `prelaunch-fixes`, 2026-11-04 UTC; `dc50c8a` and `8702a4b`, which change release-runner messages, keeper alert text and the queue scan only, landed during and after the run and do not change the grade) · **Public copy:** not yet synced · **Mode:** rescore · **Rubric:** v2 · **Previous runs:** rescore on `e48013e` (2026-11-01), 9.8/10, kept in [REPORT-2026-11-01-e48013e.md](REPORT-2026-11-01-e48013e.md); rescore on `071fee4`, 9.6, in [REPORT-2026-10-31-071fee4.md](REPORT-2026-10-31-071fee4.md); full on `b9af4a4` (2026-10-31), 8.2, in [REPORT-2026-10-31-b9af4a4.md](REPORT-2026-10-31-b9af4a4.md).

Scope (unchanged, file list in [SCOPE.md](SCOPE.md)):
- In scope: `contracts/` and `app/`.
- Out of scope: `web/`.
- Nothing is on mainnet. The testnet (46630) deployment holds no value, so it is not counted as live.
- Every suite ran in an isolated copy (`git archive`) after `bun install --frozen-lockfile --ignore-scripts`.

Rescore means every open finding was re-checked, scans and suites were re-run, and the repo was re-graded. The 26 commits `e48013e..97d108d` were reviewed as new code. The review included a hunt for one bug class: a source read that only answers while the market or event is open.

## Verdict
**Grade: 9.8 / 10.** No cap binds. The weighted score is 9.805 (was 9.85).
- Caps: the full run (2026-10-31) is within 30 days, and nothing is live.
- One finding escaped every earlier run and is fixed in this range: H-1, Gamma's list endpoint left out closed markets. It was High while open.
- The same hunt found one new Low, L-7: The Odds API keeps finished games for 3 days only. B goes from 10.0 to 9.7.
- The oracle-staleness and large-outflow alerts have landed. The monitoring item still scores 0 because the SECURITY.md signer contacts are placeholders.

## Change since the last run
| Cat | e48013e | 97d108d | Why |
|---|---|---|---|
| A | 10.0 | 10.0 | `contracts/src` unchanged. `Deploy.s.sol` changed in a comment only (RESOLVER_CREATOR now means the relayer). `deploy-mainnet.sh` and `fork-dryrun.sh` gained nonce and commit guards |
| B | 10.0 | 9.7 | L-7 open (-0.3); H-1 fixed |
| C | 10.0 | 10.0 | App 97.42% lines (re-measured on 97d108d), contracts 97.12% |
| D | 9.0 | 9.0 | Staleness and outflow alerts added; contacts still placeholders (`SECURITY.md:114-121`) |
| E | 10.0 | 10.0 | 9 high, none reachable (hono CORS: origin function, `app.ts:27`) |
| F | 10.0 | 10.0 | Slither on the runner from a hash-locked lock file; pins-check passes |
| G | 9.5 | 9.5 | No tag |
| **Total** | **9.85** | **9.805 -> 9.8** | |

## Findings
| # | Sev | Status | Finding | Where |
|---|---|---|---|---|
| H-1 | High while open | fixed (97d108d) | Resolved Polymarket markets vanished from the source | `app/src/sources/polymarket.ts:47-57` |
| L-7 | Low | open | The Odds API returns finished games for 3 days only | `app/src/sources/theOddsApi.ts:33-38,43-48` |
| I-9 | Info | open | No check that the deployed question creator is the API's relayer | `contracts/script/DeployBase.sol:323`, `app/src/ops/health.ts:18-40` |
| I-10 | Info | open | Outflow cursor advances after a failed Telegram send | `app/src/ops/monitors.ts:424-425`, `app/src/ops/alerts.ts:31-47` |
| I-11 | Info | open | Comment calls `feeFor` timelocked; `setFees` is instant | `app/src/api/router.ts:145` |
| I-12 | Info | open | The mainnet deploy guards are operator-declared | `contracts/script/deploy-mainnet.sh:24-30` |
| Lead | Lead | open | An attacker's own Cloudflare zone can choose `cf-ipcountry` (courtesy geo gate, testnet co-host template) | `cohost/ifso.cloudflare.caddy:10-11`, `clientIp.ts:40-46,59` |

**H-1 (fixed): resolved Polymarket markets read as pending forever.**
- `fetchGamma` read `/markets?slug=` and took `body[0]`. The list endpoint omits closed markets unless `closed=true` is passed.
- So from the moment a market resolved, the Gamma read was pending and no proposal could be made. Every Polymarket OUTCOME payment came back to the sender at expiry: a broken core function, likely, so High. Testnet showed 3 questions with no proposal 19 h after the window opened.
- Earlier runs missed it because the stubs in `coverage.gaps.test.ts` answered every URL.
- The fix uses `/markets/slug/<slug>` and treats a 404 as pending. `app/test/gamma.closedMarket.test.ts` copies the live filter and the 404.
- Checked live with read-only GETs: the list endpoint returns `[]` for a resolved market, the single endpoint returns 200 with `closed=true`, `resolved` and `["1","0"]`, and an unknown slug returns 404. `getJson` throws "404 from host", which the `startsWith("404 ")` check matches.
- Closed markets are still refused at build (`resolver.ts:167`).
- The testnet script uses the same endpoint, and its panel step throws instead of guessing (`exercise.ts:368-375,442-443`).

**L-7 (open): finished games drop out of The Odds API after 3 days.**
- `fetchScore` uses `/scores/?daysFrom=3&eventIds=`. The provider's v4 docs say valid values are integers from 1 to 3.
- After 3 days the event is missing, so `toReport(undefined)` is pending. The void-after-24 h branch never runs, because it needs the event to be present.
- Two final sources can then never agree. A met payment is refunded at expiry instead of paid.
- A correct foreign proposal backed only by TheSportsDB is "unconfirmed": `classifyForeign` keeps only the latest read per provider, so a later pending read replaces an earlier final one. The resolver then disputes the proposal in the last-call slot and the panel decides.
- Likelihood is unlikely: it needs no successful read for 3 days. The resolver ticks every 60 s, and `resolver-unresolved` fires at 48 h (`resolver.ts:496`).
- Impact: a wrong settlement without third-party loss. Low.
- Fix: store each provider's first final report and never let "event gone" downgrade it; or add a 60 h hard page.
- Test: stub the event so it is present until kickoff + 3 d and `[]` after, run the resolver at +2 d and at +4 d, and assert the +4 d read is not pending.
- Verify live with a key once the server has one (G11).

**Same bug class in every other source read:**
- Polygon CTF payouts: ok (stored forever).
- The Odds API `/events`: ok (build only, before kickoff).
- TheSportsDB `lookupevent.php?id=`: ok (lookup by id).
- `searchevents.php`: ok (build only).
- Hyperliquid: n/a (not wired).
- Chainlink rounds: ok (history kept, phase changes tested).

**Delta notes (no deduction):**
- RESOLVER_CREATOR now means the relayer (`0150a04`):
  - `createQuestion` holds no money. Ids are a hash of the spec, and `state != NONE` reverts (`IfsoOutcomeResolver.sol:151-156`).
  - The relayer key is held only by `ifso-api` (`provision.sh:79-88`). Registration happens only for a funded sender and is budgeted (`router.ts:175-186`, `questionBudget`).
  - This is less power than the old layout, where the creator key also held the bond float.
  - New coupling: question gas now comes from the relayer's ETH. It is rate-limited and covered by the low-balance probe.
- Staleness alert (`monitors.ts:293-335`): alerts on an answer of zero or below at any time. Stock feeds count 24/5 session seconds only (`price.ts:198-223`), and a closed market raises no stale alert. Each cause is deduplicated for 30 minutes.
- Outflow alert: the five escrow events match `IIfsoEscrow.sol:44-51`, and it reads only blocks the indexer has finished. Noise only: `LARGE_RELEASE_USDG=1000` fires on every 2,000 USDG challenge release.
- Revert-reason mapping (`tx.ts:130-151`): carries no secrets.
- Cloudflare site: it aborts any connection from outside Cloudflare's ranges; the default site strips the CF headers, so `TRUST_PROXY=cloudflare` behind it fails closed.
- Deploy guards: they check the nonce and the dry-run commit. `test_Deploy_EveryBroadcastingScriptIsGuarded` passes.
- Region gate opened for the US, CA and AE by owner decision (DECISIONS 41). This is a legal question, not graded.

**Earlier rows:** M-1 to M-4 and L-1 to L-6 are still fixed. The Leads and Info rows are unchanged; the reschedule-vs-VOID Lead is now also bounded by L-7.

## Verified this run
| Item | Result |
|---|---|
| Tests | forge 167/0/3 (21 suites) · bun 645/0 (79 files, 99.8 s) · tsc 0 |
| Coverage | App 97.42% (`monitors.ts` 98.6, `polymarket.ts` 97.8, `price.ts`/`tx.ts`/`chain.ts` 100) · contracts 97.12% |
| Invariants, mutation, Halmos | Not re-run (`contracts/src` unchanged): 500k calls per suite, 129/129 mutants killed, 13 proofs |
| Semgrep | 20 findings, 20 allowlisted, 0 new, 0 stale |
| Secrets | gitleaks: no leaks · hygiene_scan: clean |
| CI pins | pins-check pass |
| Advisories | 9 high, each traced unreachable; zod bounded by the 1 MB body cap |
| Live | Gamma GETs (H-1); Odds API docs (L-7) |
| Deploy | Not on mainnet |

## Score
| Cat | Score | Weight | Weighted |
|---|---|---|---|
| A | 10.0 | 35% | 3.500 |
| B | 9.7 | 15% | 1.455 |
| C | 10.0 | 15% | 1.500 |
| D | 9.0 | 10% | 0.900 (monitoring 0: contacts) |
| E | 10.0 | 5% | 0.500 |
| F | 10.0 | 10% | 1.000 |
| G | 9.5 | 10% | 0.950 (no tag) |
| **Total** | | | **9.805 -> 9.8**, no cap |

**Independent check:** a fresh agent recomputed 9.805 and could not refute L-7 or the H-1 fix; no new Medium or above; its spot checks matched (D handed-over checks, F toolchain pins, the D and G zeros). Adopted: the Lead, I-12, and the testnet wording. Rejected: its coverage caveat, because coverage was re-measured on 97d108d.

## Path to 10
| # | Change | Size | Points | Projected |
|---|---|---|---|---|
| 1 | Fill the SECURITY.md signer table | S | +0.10 | 9.9 |
| 2 | Tag the audited commit | S | +0.05 | 9.9 |
| 3 | L-7 fix + test | M | +0.045 | 10.0 |

No points, still worth doing: I-9 readiness probe; I-10 cursor fix; bump hono, drizzle, trpc and zod; one real football outcome end to end with a key.

---
An AI audit grade is a strong pre-audit signal, not a substitute for a human audit before large TVL.

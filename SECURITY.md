# Security policy

## Reporting a vulnerability
Email **security@ifso.tech** with a description, the affected contract or service, and steps or a proof of concept
(a Foundry test is ideal). Please do not open a public issue and do not test against live deployments with real
funds. We aim to acknowledge reports within 72 hours and to share a fix plan within 7 days. There is no paid
reward programme yet.

## Status
- The contracts have **not had an external audit**. They have had internal reviews and run with a launch cap of
  **1,000 USDG per side of each payment** (`IfsoEscrow.maxAmount`) for the first 14 days. An external audit comes
  before the cap is raised.
- Contracts are not upgradeable. Deployments are recorded in `contracts/deployments/<chainid>.json` and verified
  on Sourcify (`contracts/script/verify-sourcify.sh`).

## Scope
In scope:
- `contracts/src/` (except `contracts/src/mocks/`): `IfsoEscrow`, `IfsoConditionEvaluator`, `IfsoOutcomeResolver`,
  `FeeRouter`, and the libraries and utilities they use.
- `contracts/script/` (deploy, post-deploy checks, verification).
- `app/`: the keeper, price watcher, resolver, indexer, relayer and API, for anything that can block exits, move
  funds, waste the operator's gas or bypass rate limits or authorisation.

Out of scope:
- Mocks and tests, and third parties: the USDG issuer, Chainlink, Pyth, the Robinhood Chain sequencer, data
  providers.
- Look-alike websites, social engineering, attacks that need a compromised device or browser extension.
- Anything that needs the owner or panel multisig to act maliciously beyond the powers listed below.
- Gas optimisations and style.

## Trust assumptions

### Owner multisig (2-of-3, separate from the panel)
Every contract is owned by the owner multisig (two-step transfer: it must call `acceptOwnership`). No owner
function can move, redirect or freeze escrowed USDG (invariant R7, `contracts/INVARIANTS.md`). Full list:

| Contract | Function | Effect | Delay |
|---|---|---|---|
| IfsoEscrow | `setFees` | Flat creation / resolver fee for new payments, each at most 5 USDG | instant |
| IfsoEscrow | `setCreationPaused` | Pauses new payments and challenge accepts only; claim, settle, decisions, cancel and refund keep working | instant |
| IfsoEscrow | `setMaxAmount` | Launch cap for new payments and accepts (0 removes it); never affects exits | instant |
| IfsoConditionEvaluator | `setFeed`, `setPythId`, `setResolver` | Which feeds, price ids and resolvers new payments may use; existing payments are unaffected | instant |
| IfsoOutcomeResolver | `setCreator` | Which service keys may register questions | instant |
| IfsoOutcomeResolver | `setBondAmount` | Bond for new proposals and disputes (10 to 10,000 USDG) | instant |
| IfsoOutcomeResolver | `queuePanel` / `applyPanel` | Replaces the panel multisig | 48 h |
| FeeRouter | `setRecipients` | Where creation fees are split (80 / 10 / 5 / 5) | instant |
| all four | `transferOwnership` / `acceptOwnership` | Two-step ownership change | until accepted |

### Other roles
- **Panel multisig**: decides disputed outcome questions within 72 h; if it stays silent the question is VOID and
  each side gets its own money back. It cannot touch any other payment.
- **Resolver service**: registers questions and proposes results with a bond; anyone can dispute with a matching
  bond. Its keys never hold user funds.
- **Referee**: chosen per payment by the sender; can only release to the recipient or return to the sender.
- **USDG issuer**: can freeze any address, including the escrow contract. A freeze of the escrow stops every exit.
  A frozen refund address of one side of a challenge never holds the other side's money: each side is paid on its
  own and a side that cannot receive is left for `claimVoid`.
- **Oracles**: Chainlink feeds decide PRICE conditions; a price within about 0.5% of the level can resolve either
  way because of the feed's deviation threshold. The Pyth adapter is shipped but not wired on Robinhood Chain in v1
  (`pyth = 0`, immutable, asserted by the deploy script); turning it on is a new deploy and a new review round.
- **Sequencer**: may refuse some addresses; every payment has an alternate refund address and refunds are open to
  anyone after expiry.

## Accepted risks
| Risk | Why it is accepted |
|---|---|
| Owner setters other than the panel change are instant, not timelocked | They only affect new payments (fees capped at 5 USDG, registry, pause, cap) and can never touch escrowed USDG (R7). The panel change, which affects open questions, has a 48 h delay. |
| The owner multisig can raise or remove the launch cap at once | The cap limits new exposure only; raising it is planned after 14 days and after an external audit. Exits never depend on it. |
| No sequencer uptime feed on Robinhood Chain | None is published on the chain today; the evaluator takes it as an immutable, the deploy defaults to none and asserts the configured value. AT_DEADLINE uses round-id proofs and a hold window, so a sequencer outage delays settlement but cannot pick a stale price; expiry refunds still work. |
| USDG issuer freeze of the escrow contract | Outside the protocol's control; disclosed on every create and claim page. |
| Claim links work like cash | Whoever holds the link first can claim; mitigated by expiries, cancellable payments and private sending. |
| Relayed decisions and refund-address changes use one nonce per signer (R1-I1) | Signatures relayed out of order fail and must be signed again; no funds are at risk. The app signs one at a time. |
| No ERC-6492 in signature checks (R1-I2) | A passkey account that is not deployed yet cannot sign `decideBySig` until it is deployed; claims do not need it (the link key signs). EIP-7702 delegated EOAs are checked through ERC-1271. |
| `_multiplierChanged` uses try/catch (R1-I3) | An unreadable multiplier or schedule field fails closed (VOID). Out-of-gas griefing of the catch was checked: the 1/64 left to the caller cannot complete the refund, so it cannot force a wrong verdict. |
| Corporate actions void decided results that are settled late (R2-L1) | ERC-8056 keeps only the latest schedule, so a schedule that took effect between the deciding price and the settle VOIDs (the multiplier in force at the price cannot be proven). The keeper settles PRICE payments before an announced `effectiveAt`; a late settle returns the money instead of paying on a possibly re-based price. Residual: three or more actions where one lands after the deciding price, a later one restores exactly the snapshot value and a third is still pending at settle cannot be detected from one schedule; `validate` refuses any known schedule before deadline + hold. |
| An OUTCOME proposal made more than 2 days late can still be disputed past expiry (R2-L2, R1-M3 residual) | The expiry minimum is `earliestResolve + 2 days + disputeWindow + panelWindow + 1 day` (6 days 2 hours with the deployed windows); the app uses `earliestResolve + 7 days`, which covers proposals about 70 h late. Later than that, a losing side's dispute can run the panel window past expiry and the challenge VOIDs (each side gets its own money back, nothing is lost). A settle grace after expiry was rejected because it would race or block the permissionless refund. The resolver service proposes at `earliestResolve` and alerts at 48 h. |
| `_tryPay` out-of-gas bound (R2-I1) | A failed USDG transfer that left the escrow `g/16` or less of the gas it had before the call reverts the whole call. USDG is a proxy, so an out-of-gas in its inner frame hands back about 2/64 of the gas, above the plain 63/64 bound (`g/63`); `g/16` covers that with margin. A transfer that fails normally (blocked address) returns almost all the gas and is recorded as owed. Test with a proxy-shaped USDG whose transfer burns 3M gas: `test_R2_I1_*`. |
| A caller of `refund` on a VOIDed challenge chooses which preset destination each side is paid to | Only that side's own preset destinations are possible; a side whose chosen destination cannot receive is left owed and anyone can pay it later with `claimVoid`. |
| The resolver service may lose a bond on an honest proposal its sources cannot confirm in time (R3-H1 residual) | A foreign proposal that stays unconfirmed (sources pending, unavailable or conflicting, e.g. a disputed result upstream) until the last-call slot is disputed; if it was honest the panel pays the proposer our bond. Losses are capped by the concurrent last-call budget (`floor(float / bond) - 1`, one bond always kept for a contradicted proposal); over budget the service pages a human, who must dispute from the panel runbook within the 2 h window; a lost last-call dispute raises an alert. This is rare, not certain: a football question is only planned and registered when both result sources (The Odds API and TheSportsDB) have an id for the match, so the service can always confirm with two (audit M-2); a proposal that a final source contradicts, with no final source backing it, counts as contradicted and is disputed at once instead of waiting for the last-call slot; Polymarket questions resolve at endDate + 24 h. What remains is a lagging or split upstream result, not a question that can never be confirmed. |
| The resolver bond float is an operating risk | The service needs its USDG float (about 500 USDG) to dispute. A float or budget alert is not a promise: an unconfirmed proposal that is not disputed in time can be finalized by anyone once the window closes; the service itself never finalizes it and alerts. |
| The panel multisig is trusted on disputed outcome questions | Panel silence gives VOID (each side refunded), never a forced result. |
| Gasless decisions depend on the relayer | A party with no ETH needs the relayer for a gasless decision; the per-escrow relay cap is per signer and terminal decisions are never capped (R3-M1), and direct on-chain calls always remain available. |
| Services share one Postgres role; the deploy user owns the code tree (R3-I2) | api, bot and worker run as separate Unix users with separate keys, but use one database role, and code written by the deploy user runs as every role (PRIV-5 partial). |
| Wallet linking only notifies | A wallet linked to a Telegram account only receives notifications about its payments; the signed message names the site and an expiry (R3-I1), and the link moves no money. One wallet may be linked to several Telegram accounts. |
| This is an internal review, not an external audit | The three internal rounds are AI-assisted: a strong pre-audit signal, not a substitute for a human audit before the launch cap rises. |
| Read-only reentrancy during `settle` | The Pyth fee refund sends ETH to the caller before the escrow record is updated; every state-changing entry point is `nonReentrant`, so only view reads see the old record. Integrators should not read escrow state inside that callback. |

## Audit history
| Date | Review | Scope | Result |
|---|---|---|---|
| 2026-10-30 | Internal hardening pass | launch cap, invariants (10,000 x 50), deploy safety, CI, Slither allowlist | No open High or Medium in the contracts; findings and reasons in `contracts/slither.allow` |
| 2026-10-30 | Internal security review, round 1 of 3 | contracts, deploy scripts, app services | 0 High, 8 Medium, 4 Low, 6 Info. Contract fixes: M1 (challenge accept window vs `maxStale`), M2 (no two-sided TOUCH), M3 (OUTCOME expiry covers the panel window), M4 (each side of a VOID paid on its own, `claimVoid`), M5 on-chain part (no-op decisions and refund changes revert), L1 (multiplier judged at the deciding price's time), L2 (Pyth not wired on RHC), L4 (cap and Safe checks in the deploy assertions), I6 (deploy guard on every non-local chain). Each finding has `test_R1_*` regression tests. App findings (M5 rate limits, M6, M7, M8, L3) are tracked for the app services |
| 2026-10-30 | Internal security review, round 2 of 3 | contracts, deploy scripts, app services | 1 High, 3 Medium, 3 Low, 7 Info. Contract fixes: L1 (multiplier check fails closed for two or more corporate actions), L2 (OUTCOME expiry covers a proposal up to 2 days late; residual accepted above), I1 (starvation bound covers the USDG proxy). `test_R2_*` regression tests, Halmos `check_R2L1_*`, mutants `R2-*`. App findings (H1, M1, M2, M3, L3) are tracked for the app services |

| 2026-10-31 | Internal security review, round 3 of 3 (final) | contracts delta, app services | Contracts: no new finding. App: 1 High, 1 Medium, 2 Low, 2 Info. Fixed in the app: H1 (foreign disputes only when contradicted, or in a budgeted last-call slot), M1 (relay cap per escrow and signer, terminal decisions uncapped), L1 (stats cache, per-network read budget), L2 (back-off and per-pass cap for rows before a multiplier change), I1 (link message names the site and expiry); I2 accepted above. Regression tests `app/test/reviewR3.*`, property test `app/test/resolverPolicy.property.test.ts` |

## Incident response (short form)
1. Owner multisig pauses new entries (`setCreationPaused(true)`); exits keep working.
2. Lower or keep the launch cap; never needed for users to exit.
3. Tell users through the app and the bot; refunds after expiry need no website (`refund(id, false, false)` from any
   wallet or block explorer).
4. Publish a post-incident note and add a regression test for the cause.

See also `contracts/THREAT-MODEL.md` and `contracts/INVARIANTS.md`.

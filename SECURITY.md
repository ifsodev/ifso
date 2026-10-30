# Security policy

## Reporting a vulnerability
Email **security@ifso.app** with a description, the affected contract or service, and steps or a proof of concept
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
- **Oracles**: Chainlink feeds (and Pyth if the owner allows a price id) decide PRICE conditions; a price within
  about 0.5% of the level can resolve either way because of the feed's deviation threshold.
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
| Read-only reentrancy during `settle` | The Pyth fee refund sends ETH to the caller before the escrow record is updated; every state-changing entry point is `nonReentrant`, so only view reads see the old record. Integrators should not read escrow state inside that callback. |

## Audit history
| Date | Review | Scope | Result |
|---|---|---|---|
| 2026-10-30 | Internal hardening pass | launch cap, invariants (10,000 x 50), deploy safety, CI, Slither allowlist | No open High or Medium in the contracts; findings and reasons in `contracts/slither.allow` |

## Incident response (short form)
1. Owner multisig pauses new entries (`setCreationPaused(true)`); exits keep working.
2. Lower or keep the launch cap; never needed for users to exit.
3. Tell users through the app and the bot; refunds after expiry need no website (`refund(id, false, false)` from any
   wallet or block explorer).
4. Publish a post-incident note and add a regression test for the cause.

See also `contracts/THREAT-MODEL.md` and `contracts/INVARIANTS.md`.

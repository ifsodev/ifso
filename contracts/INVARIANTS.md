# Invariants

Three contracts hold or route value, and each has a handler-based suite: IfsoEscrow (R4-R8), IfsoOutcomeResolver
(OR1-OR5) and FeeRouter (FR1-FR3). Each suite runs 10,000 runs x depth 50 (500,000 random calls) in the
`invariant` profile.

## IfsoEscrow

Each property below is checked by a test that runs in CI. The handler-based suite lives in
`test/invariant/` and runs 10,000 runs x depth 50 (500,000 random calls) in the `invariants` CI job:

```bash
FOUNDRY_PROFILE=invariant forge test --match-test invariant -vv
```

The handler (`test/invariant/EscrowHandler.sol`) drives every user path (create TIME / APPROVE parties / APPROVE
referee / two-sided challenges, PRICE AT_DEADLINE and TOUCH one-sided and as attempted challenges, OUTCOME one-sided
and challenges on fresh resolver questions, named and claim-link, accept, claim, settle with "" and with feed round
proofs, approve, decline, referee decision, cancel, refund, refund-address and acceptor-refund changes, claimVoid,
time warps), moves the feed and the resolver (propose, dispute, finalize, panel answer, panel time-out), lets the USDG
issuer freeze and unfreeze refund destinations, recipients and alternates, sends stray USDG straight to the escrow,
and calls every owner function (fees, pause, launch cap, ownership transfer, feed and resolver registry).
`test_HandlerReachesR1Paths` proves the PRICE, OUTCOME, freeze and claimVoid paths reach their success branches. Amounts deliberately cross the
1,000 USDG launch cap so both sides of the cap check are exercised. `test_HandlerReachesEveryPath` fails if a
handler path stops reaching its success branch, so the suite can never pass by doing nothing.

| # | Invariant (in words) | Test |
|---|---|---|
| R4 | The escrow's USDG balance always equals what it owes: the sum over every OPEN or MET escrow of its amount, plus the counter amount when a challenge was accepted, plus every still-owed side of a VOIDED challenge. USDG sent to the contract by mistake stays on top of that and is never paid to anyone. | `invariant_BalanceMatchesObligations` |
| R5 | An escrow's status never moves backwards. Once RELEASED, RETURNED, VOIDED or CANCELLED it never changes again; MET only ends as RELEASED (claimed) or RETURNED (refund after expiry). | `invariant_NoStatusRegression` |
| R6 | After its expiry, every OPEN or MET escrow can be refunded by any caller, with new entries paused or not, and the refund ends it. With USDG freezes in play: an accepted challenge always refunds (each side is paid on its own; a frozen side is left owed, never the other side's money); any other escrow refunds unless every destination of its sender side is frozen (only the sender's own money). Every owed VOID side is claimable by anyone once its destination can receive. At the end of every run the suite jumps past the last expiry and runs this check twice: with the run's freezes still in place, then after the issuer lifts them, when the contract must hold only the stray USDG. | `invariant_RefundAlwaysPossibleAfterExpiry` (+ `afterInvariant`) |
| R7 | No owner function changes any escrow's record (recipient, amounts, refund addresses, status) or the escrow's USDG balance. | `invariant_OwnerCannotMoveFunds` |
| R8 | No challenge whose deciding result could be known before its accept window closes is ever created: two-sided TOUCH and AT_DEADLINE with `acceptBy + maxStale >= deadline` are refused (review R1-M1, R1-M2). | `invariant_NoKnowableChallengeCreated` |

## IfsoOutcomeResolver

Suite: `test/invariant/ResolverInvariants.t.sol`. The handler creates questions, proposes (any outcome, from four
bonded actors), disputes, finalizes, answers as the panel (agreeing and disagreeing, VOID included), times the panel
out, withdraws bonds (to self and to another address), changes the bond between a proposal and its dispute, sends
stray USDG to the resolver, tries self-disputes (the proposer disputing its own proposal, audit M-1), forwards
forfeits to the FeeRouter and warps time. Expected credits are computed in the handler from the rules in the
contract header, never read back from the resolver. `test_ResolverHandlerReachesEveryPath` fails if any path stops
reaching its success branch.

| # | Invariant (in words) | Test |
|---|---|---|
| OR1 | The resolver's USDG balance equals the sum of every claimable bond plus every live bond (one bond for a PROPOSED question, two for a DISPUTED one, each at the bond snapshotted at proposal), plus forfeits not yet forwarded (`forfeited`), plus USDG sent to it by mistake. Forwarded forfeits reached the FeeRouter and nobody else. | `invariant_ResolverBalanceEqualsBonds` |
| OR2 | No double credit: no question is credited by two terminal calls; everything ever credited (claimable + withdrawn) equals the pots of the questions that reached FINAL or VOID; credited + live + forfeits (held and forwarded) equals every bond ever posted; forfeits equal the spec (panel: `ceil(bond / 2)` of the loser's bond; silence: `2 * ceil(bond / 2)`). | `invariant_ResolverNoDoubleCredit` |
| OR3 | Each pot goes to the right party: undisputed FINAL pays the proposer its bond; a panel answer equal to the proposal pays the proposer its bond plus `floor(bond / 2)` of the disputer's, any other answer (VOID included) pays the disputer its bond plus `floor(bond / 2)` of the proposer's; a panel time-out returns each side `floor(bond / 2)` (audit M-1). | `invariant_ResolverCreditsRightParty` |
| OR4 | A question's state only moves forward (OPEN -> PROPOSED -> FINAL, or PROPOSED -> DISPUTED -> FINAL / VOID). FINAL and VOID never change again. | `invariant_ResolverStatesOnlyMoveForward` |
| OR5 | No free self-dispute (audit M-1): no question is ever disputed by its own proposer (proposer == disputer never succeeds), and every disputed question that resolves (panel for, against, VOID, or silent) forfeits at least `bond / 2`, measured on the contract, so two addresses of one owner cannot make a dispute free. Also proved symbolically for every bond in bounds and every answer (Halmos `check_ResolverDisputeSplit`) and per branch in `test/pocs/AuditM1SelfDispute.t.sol`. | `invariant_ResolverNoFreeSelfDispute` |

## FeeRouter

Suite: `test/invariant/FeeRouterInvariants.t.sol`. The handler sends fee inflows of any size (most do not divide by
20, so rounding is exercised), calls the permissionless `distribute`, changes recipients as the owner (one address
may hold two roles), freezes and unfreezes a recipient at the USDG issuer, sweeps a stray token and tries to sweep
USDG. Since audit M-1 it also drives a REAL `IfsoOutcomeResolver` wired to the router (a disputed question answered or
timed out, then `forwardForfeits`), so forfeited bond halves are counted as inflow in FR1-FR3. Expected amounts come
from the documented 80/10/5/5 rule computed in the handler.
`test_FeeRouterHandlerReachesEveryPath` covers rounding, a shared address, a frozen recipient (the whole distribute
is refused and the router keeps everything, never a partial split) and both sweep paths.

| # | Invariant (in words) | Test |
|---|---|---|
| FR1 | Conservation: every USDG unit that reached the router is either still in it or was paid to a configured recipient. USDG can never be swept. | `invariant_FeeRouterConserves` |
| FR2 | Exact split: each recipient received exactly treasury = floor(10%), perks = floor(5%), burn = floor(5%), work = the rest, of every distribute, with the recipients configured at that moment. | `invariant_FeeRouterExactSplit` |
| FR3 | No stuck dust: a successful distribute leaves 0 USDG in the router, and the rounding remainder that goes to work is at most 3 base units (0.000003 USDG) per distribute. This is the documented rounding. | `invariant_FeeRouterNoStuckDust` |

## Mutation check of the resolver and fee router invariants (2026-10-31)

Each mutant is in `tools/mutants.py` (ids `INV-*`), so `tools/mutation.sh` runs it on every mutation run. Below,
each was also run against the two new suites alone (default profile) to show which invariant it breaks.

| Mutant | Change | Broken invariant (assertion) |
|---|---|---|
| `INV-OR1-withdraw` | `withdrawBond` sends one unit less than it clears | OR1 (`balance != claimable + live bonds + stray`) |
| `INV-OR2-refinalize` | `finalize` leaves the question PROPOSED, so it can be finalized again | OR2 (`credited + live != bonds posted`, run alone), OR1 |
| `INV-OR3-timeout-party` | panel time-out returns the disputer's bond to the proposer | OR3 (`actor credited a different amount than the rules give`) |
| `INV-OR4-repropose` | a VOID question can be proposed again | OR4 (`a question moved backwards or left a terminal state`) |
| `INV-FR1-leak` | the burn share goes to an address that is not a recipient | FR1 (`USDG in != held + paid`), FR2 |
| `INV-FR2-misroute` | the treasury share goes to the work address | FR2 (`recipient paid != its share`) |
| `INV-FR3-stuck` | work takes floor(80%), so the rounding remainder stays in the router | FR3 (`USDG left in the router after distribute`), FR2 |

Result: 7 / 7 killed by the targeted invariant.

## Mutation check of the audit M-1 fix (2026-11-05)

Mutants `AM1-*` in `tools/mutants.py` undo the fix one branch at a time: self-dispute allowed again, the panel winner
takes both whole bonds, the panel forfeit not booked or rounded down, silence returning whole bonds, silence booking no
forfeit or only one half, `forwardForfeits` not clearing the counter, paying the caller instead of the FeeRouter,
accepting an empty forward, and a zero FeeRouter in the constructor. `R-pot`, `R-timeout-credit` and
`INV-OR3-timeout-party` were re-pointed at the new split. Resolver mutants: 30 / 30 killed.

## Launch cap rules

| Rule | Test |
|---|---|
| Creates and accepts above `maxAmount` revert; exactly `maxAmount` passes (one-sided, both sides of a challenge, batches) | `test_Cap_AboveReverts_AtCapPasses`, `testFuzz_Cap_Boundary` |
| Lowering the cap (and pausing) never blocks claim, settle, approve, decline, referee decision, cancel or refund | `test_Cap_LoweredDoesNotBlockExits` |
| Accepting an existing challenge is a new entry and is checked against the cap in force at that moment | `test_Cap_AcceptGated` |
| Only the owner sets the cap; a non-zero cap below the 1 USDG minimum is refused | `test_Cap_OnlyOwner` |

## Other property tests

| Property | Test |
|---|---|
| Refund works after expiry for any amount, paused or not, link or named | `testFuzz_RefundAlwaysWorksAfterExpiry` |
| Owner actions never touch escrowed USDG | `test_OwnerHasNoPathToEscrowedFunds` |
| Pause gates only new entries | `test_Pause_GatesOnlyNewEntries` |
| An accept and an outcome proposal never share a second: `acceptBy < closeTime < earliestResolve` (audit I-16; mutants `AI16-*`) | `test_I16_*`, `testFuzz_I16_AcceptAndProposeNeverShareASecond` |
| Deploy script refuses on Robinhood Chain (4663, 46630) unless armed; every broadcasting script carries the guard | `test_Deploy_RefusesUnarmedOnRealChainIds`, `test_Deploy_EveryBroadcastingScriptIsGuarded` |
| A local run of the deploy script passes the post-deploy assertions with the launch values | `test_Deploy_LocalRunPassesAssertions` |
| PostDeployCheck: on 4663 the launch values are hard-coded constants (USDG, five feed proxies and their Stock Tokens, 1,000 USDG cap, fees, bond, 2 h / 72 h windows); any drift fails | `test_PostDeploy_MainnetConstants` |
| PostDeployCheck: runtime code of all four contracts equals the build output with immutables masked; one flipped byte or a different contract fails | `test_PostDeploy_RuntimeCodeMatchesBuild`, `script/fork-dryrun.sh` |
| PostDeployCheck `REQUIRE_HANDED_OVER=1`: fails while ownership is pending or if the deployer kept a role; passes once the owner multisig accepted everywhere | `test_PostDeploy_HandedOverMode`, `script/fork-dryrun.sh` |

## Mutation check of the invariant suite (2026-10-30)

Each mutant was applied to `src/IfsoEscrow.sol` by hand and the default-profile invariant suite was run.

| Mutant | Killed by |
|---|---|
| `refund` reverts while new entries are paused | R4, R6 |
| `_release` sends one unit less than owed | R4, R6, `test_HandlerReachesEveryPath` |
| `setFees` moves 1 unit of USDG to the owner | R4, R6, R7 |
| `cancel` leaves the status OPEN after sending the funds | R4, R6 |

Result: 4 / 4 killed.

## Mutation check of the review round 1 fixes (2026-10-30)

| Mutant | Killed by |
|---|---|
| VOID pays both sides with reverting transfers again (the R1-M4 bug) | R6 (`afterInvariant`, frozen-state pass), `test_HandlerReachesR1Paths`, `test_R1_M4_*` |
| `_tryPay` without the out-of-gas guard | `test_R1_M4_OutOfGasInsideTransferReverts_NotOwed` |
| repeated OK allowed again (R1-M5) | `test_R1_M5_*` (2 tests each) |
| same-address refund change allowed again (R1-M5) | `test_R1_M5_*` |
| acceptor side paid with a reverting transfer | `test_R1_M4_*` |
| `claimVoid` does not clear the owed flag (double pay) | `test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims`, `test_R1_M4_OwedCounterSide_*` |

Result: 6 / 6 killed (the out-of-gas guard needed a dedicated test with a gas-hungry token: with USDG's normal
transfer cost the starvation is infeasible, so it is defence in depth).

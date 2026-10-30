# IfsoEscrow invariants

Each property below is checked by a test that runs in CI. The handler-based suite lives in
`test/invariant/` and runs 10,000 runs x depth 50 (500,000 random calls) in the `invariants` CI job:

```bash
FOUNDRY_PROFILE=invariant forge test --match-test invariant -vv
```

The handler (`test/invariant/EscrowHandler.sol`) drives every user path (create TIME / APPROVE parties / APPROVE
referee / two-sided challenges, named and claim-link, accept, claim, settle, approve, decline, referee decision,
cancel, refund, refund-address change, time warps), sends stray USDG straight to the escrow, and calls every owner
function (fees, pause, launch cap, ownership transfer, feed and resolver registry). Amounts deliberately cross the
1,000 USDG launch cap so both sides of the cap check are exercised. `test_HandlerReachesEveryPath` fails if a
handler path stops reaching its success branch, so the suite can never pass by doing nothing.

| # | Invariant (in words) | Test |
|---|---|---|
| R4 | The escrow's USDG balance always equals what it owes: the sum over every OPEN or MET escrow of its amount, plus the counter amount when a challenge was accepted. USDG sent to the contract by mistake stays on top of that and is never paid to anyone. | `invariant_BalanceMatchesObligations` |
| R5 | An escrow's status never moves backwards. Once RELEASED, RETURNED, VOIDED or CANCELLED it never changes again; MET only ends as RELEASED (claimed) or RETURNED (refund after expiry). | `invariant_NoStatusRegression` |
| R6 | After its expiry, every OPEN or MET escrow can be refunded by any caller, with new entries paused or not, and the refund ends it. At the end of every run the suite jumps past the last expiry, pauses, refunds everything from stranger addresses and checks the contract then holds only the stray USDG. | `invariant_RefundAlwaysPossibleAfterExpiry` (+ `afterInvariant`) |
| R7 | No owner function changes any escrow's record (recipient, amounts, refund addresses, status) or the escrow's USDG balance. | `invariant_OwnerCannotMoveFunds` |

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
| Deploy script refuses on Robinhood Chain (4663, 46630) unless armed; every broadcasting script carries the guard | `test_Deploy_RefusesUnarmedOnRealChainIds`, `test_Deploy_EveryBroadcastingScriptIsGuarded` |
| A local run of the deploy script passes the post-deploy assertions with the launch values | `test_Deploy_LocalRunPassesAssertions` |

## Mutation check of the invariant suite (2026-10-30)

Each mutant was applied to `src/IfsoEscrow.sol` by hand and the default-profile invariant suite was run.

| Mutant | Killed by |
|---|---|
| `refund` reverts while new entries are paused | R4, R6 |
| `_release` sends one unit less than owed | R4, R6, `test_HandlerReachesEveryPath` |
| `setFees` moves 1 unit of USDG to the owner | R4, R6, R7 |
| `cancel` leaves the status OPEN after sending the funds | R4, R6 |

Result: 4 / 4 killed.

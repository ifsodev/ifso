# Symbolic proofs (Halmos)

Halmos 0.3.3 (free, `pip`, hash-locked in `contracts/tools/halmos-requirements.txt`) executes the real contracts with
symbolic inputs and either proves the assertion for every input or returns a counterexample. Source:
`contracts/test/halmos/Halmos.t.sol`. Re-run: `bash contracts/tools/halmos.sh` (CI job `halmos`).

**Result after the round-2 contract fixes: 13 proved, 0 counterexamples, 0 timeouts (3 s solver time).**

| Proof | What holds for every input |
|---|---|
| `check_FeeRouterSplitConserves(uint128)` | The 80/10/5/5 split pays out exactly the router balance (no value created or lost); the work share is never smaller than another share; treasury is exactly 10%. |
| `check_SetFeesBoundsAndFeeFor(uint96,uint96,uint8)` | `setFees` accepts exactly the values within both 5 USDG caps; `feeFor` is `creationFee` (plus `resolverFee` for OUTCOME) and never above 10 USDG. |
| `check_CreatePullsAmountPlusReportedFee(uint96,uint96)` | For every amount and creation fee, a successful `create` takes exactly `amount + feeFor(kind)` from the sender, the escrow holds exactly `amount`, the router receives exactly the fee (view equals execution, contract side). |
| `check_CapEnforcedOnBothSides(uint96,uint96,uint96)` | With a cap set, a create succeeds only if neither the sender stake nor the acceptor stake is above it; a create with every other field valid is refused only because of the cap; `setMaxAmount` refuses a non-zero cap below the minimum. |
| `check_AtDeadlineVerdictMatchesComparison(int256,int256,bool)` | For every feed answer and threshold, an AT_DEADLINE verdict is TRUE exactly when `answer >= threshold` (GTE) or `answer <= threshold` (LTE), else FALSE; equality counts as met for both operators. |
| `check_TouchNeverReturnsFalse(int256,int256,bool)` | A TOUCH round decides TRUE iff it crosses, otherwise PENDING; TOUCH never returns FALSE. |
| `check_StaleRoundNeverDecides(uint32,int256,int256)` | A round older than `maxStale` at the deadline, with no later print yet, is always PENDING (fails closed). |
| `check_ValidateRefusesBadThresholdAndOp(int256,uint8)` | A create is accepted only with a positive threshold and a known comparator. |
| `check_R1M1_ChallengeNeedsAcceptByPlusMaxStaleBeforeDeadline(uint64,uint32)` | Round-1 M1: a challenge on an AT_DEADLINE price is accepted at creation only if `acceptBy + maxStale < deadline`. |
| `check_R1M2_TouchNeverValidForChallenge(uint64,uint64)` | Round-1 M2: a TOUCH price is never valid for a challenge. |
| `check_R1L1_PendingCorporateActionDoesNotVoid(uint256,uint32,int256)` | Round-1 L1: a multiplier schedule that takes effect after the deciding round and is still pending at settle never voids a decided result, for any new multiplier. |
| `check_R1L1_EarlierCorporateActionVoids(uint256,uint32,int256)` | A multiplier change already in force at or before the deciding round always voids it. |
| `check_R2L1_TwoActionsDecideOnlyOnTheSnapshot(uint256,uint256,uint32,uint32,uint32,bool)` | Round-2 L1: for any two corporate actions (any values and timing, lazy or applied token, any settle time) a decided verdict implies the multiplier in force at the deciding round is the creation snapshot. On the round-1 code it returns counterexamples. |

Not vacuous: with `>=` in the comparison turned into `>` (a mutant), `check_AtDeadlineVerdictMatchesComparison` and
`check_TouchNeverReturnsFalse` return counterexamples.

Scope notes: the proofs run on the real contracts against the test doubles for the feed, Stock Token and USDG; amounts
are bounded to 10^15 base units where a mock balance is needed. Proofs of Pyth scaling and the outcome resolver are not
included.

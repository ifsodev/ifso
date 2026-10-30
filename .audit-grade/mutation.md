# Mutation score

Hand-written mutants (`contracts/tools/mutants.py`) are patched one at a time into a throwaway copy of
`contracts/src`; the default `forge test` suite (unit, fuzz and the short invariant profile) must fail.
Re-run: `python3 contracts/tools/mutation.py` (needs Foundry 1.8.4; about 6 minutes). A stale or non-compiling mutant fails the run.

**Total: 113/113 killed (100.0%)** (1 equivalent mutant(s) excluded, listed below)

| File | Killed | Total | Score |
|---|---|---|---|
| `IfsoConditionEvaluator.sol` | 32 | 32 | 100.0% |
| `IfsoEscrow.sol` | 56 | 56 | 100.0% |
| `IfsoOutcomeResolver.sol` | 15 | 15 | 100.0% |
| `FeeRouter.sol` | 6 | 6 | 100.0% |
| `utils/Owned2Step.sol` | 4 | 4 | 100.0% |

## Round-1 finding mutants (each undoes one fix)

| Mutant | Finding | What it undoes | Result |
|---|---|---|---|
| M1-a | R1-M1 | challenge acceptBy + maxStale may equal the deadline | KILLED |
| M1-b | R1-M1 | no acceptBy/maxStale rule for AT_DEADLINE challenges | KILLED |
| M2-a | R1-M2 | two-sided TOUCH accepted again | KILLED |
| M3-a | R1-M3 | OUTCOME expiry ignores the panel window | KILLED |
| M3-b | R1-M3 | OUTCOME expiry ignores the dispute window | KILLED |
| M3-c | R1-M3 | OUTCOME expiry ignores the settle margin | KILLED |
| M4-a | R1-M4 | a failing sender-side VOID payout reverts the whole VOID again | KILLED |
| M4-b | R1-M4 | a failing acceptor-side VOID payout reverts the whole VOID again | KILLED |
| M4-c | R1-M4 | a gas-starved transfer can push a payable side into owed | KILLED |
| M4-d | R1-M4 | claimVoid does not clear the owed flag (double payout) | KILLED |
| M4-e | R1-M4 | claimVoid works on a side that is not owed | KILLED |
| M4-f | R1-M4 | an owed sender side can no longer redirect its refund | KILLED |
| M4-g | R1-M4 | an owed acceptor side can no longer redirect its refund | KILLED |
| M4-h | R1-M4 | refund addresses can change after the escrow is closed | KILLED |
| M4-i | R1-M4 | owed flag is set on the wrong side (sender paid owed as counter) | KILLED |
| M5-a | R1-M5 | a repeated OK is accepted again (relayer-paid no-op) | KILLED |
| M5-b | R1-M5 | re-setting the same refund addresses is accepted again | KILLED |
| L1-a | R1-L1 | a later corporate action VOIDs a decided result again | KILLED |
| L1-b | R1-L1 | a change in force before the deciding round no longer VOIDs | KILLED |
| L1-c | R1-L1 | a differing multiplier is accepted whatever its schedule | KILLED |
| L1-d | R1-L1 | a differing multiplier always VOIDs, even when scheduled after | KILLED |
| L1-e | R1-L1 | an unreadable multiplier no longer fails closed | KILLED |
| L1-f | R1-L1 | a schedule change at the deciding round's exact second is ignored | KILLED |

## Survivors

None.

## Equivalent mutants (no observable behaviour change)

- X-activefrom (`IfsoEscrow.sol`): activeFrom only feeds TOUCH windows and two-sided TOUCH is refused (R1-M2)

## All mutants

| Mutant | File | Result | First failing test |
|---|---|---|---|
| M1-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Challenge_AcceptByPlusMaxStaleEqualDeadline_Refused() (gas: 445182) |
| M1-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadlineChallenge_AcceptByMustPrecedeDeadline() (gas: 440002) |
| M2-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_TouchChallenge_RefusedAtCreation() (gas: 439846) |
| M3-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M3_Outcome_DisputeRunsOutTheClock() (gas: 492392) |
| M3-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M3_Outcome_DisputeRunsOutTheClock() (gas: 552911) |
| M3-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M3_Outcome_DisputeRunsOutTheClock() (gas: 554315) |
| M4-a | `IfsoEscrow.sol` | KILLED | [FAIL: EvmError: Revert] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 588369) |
| M4-b | `IfsoEscrow.sol` | KILLED | [FAIL: EvmError: Revert] test_Void_OwedAcceptorSide_CanRedirectThenIsPaid() (gas: 549623) |
| M4-c | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("starved side marked owed: 32 != 0")] test_R1_M4_OutOfGasInsideTransferReverts_NotOwed() (gas: 7039512) |
| M4-d | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 973993) |
| M4-e | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 701023) |
| M4-f | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 803061) |
| M4-g | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_Void_OwedAcceptorSide_CanRedirectThenIsPaid() (gas: 615409) |
| M4-h | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 1010358) |
| M4-i | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender side owed: 0 != 32")] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 630883) |
| M5-a | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M5_NoOpRevertsNoChange_RealChangesStillWork() (gas: 400998) |
| M5-b | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M5_NoOpRevertsNoChange_RealChangesStillWork() (gas: 539958) |
| L1-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("deadline price was pre-split and decided: should release")] test_R1_L1_SplitAfterDeadline_VoidsADecidedResult() (gas: 757404) |
| L1-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("lazy change at the deciding round: VOID")] test_R1_L1_ChangeAtOrBeforeDecidingRound_Voids() (gas: 1500752) |
| L1-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("VOID on corporate action")] test_MultiplierChange_Voids() (gas: 721103) |
| L1-d | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("change after the deciding round: decided result stands")] test_R1_L1_AppliedChangeAfterDecidingRound_StillReleases() (gas: 784325) |
| L1-e | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("VOID, not RELEASED, when the multiplier is unreadable")] test_Multiplier_UnreadableFailsClosedToVoid() (gas: 777827) |
| L1-f | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("applied change at the deciding round: VOID")] test_R1_L1_ChangeAtOrBeforeDecidingRound_Voids() (gas: 1682293) |
| E-cross-gte | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("inclusive comparators")] test_AtDeadline_EqualityCountsForGteAndLte() (gas: 1180040) |
| E-cross-lte | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("inclusive comparators")] test_AtDeadline_EqualityCountsForGteAndLte() (gas: 1203674) |
| E-time | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_Cap_LoweredDoesNotBlockExits() (gas: 2514776) |
| E-after-deadline | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_NotSettleableAtTheDeadlineSecond() (gas: 670825) |
| E-round-after | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_AtDeadline_EarlierRoundIsNotLastWhenNextIsAtTheDeadline() (gas: 786643) |
| E-last-round | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_EarlierRoundIsNotLastWhenNextIsAtTheDeadline() (gas: 767752) |
| E-stale | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_AtDeadline_RoundExactlyMaxStaleOldIsFresh() (gas: 623431) |
| E-hold | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("decided on the print at the limit")] test_AtDeadline_PrintExactlyAtTheHoldLimitDecides() (gas: 769263) |
| E-hold-wait | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_NoPrint_PendingUntilTheHoldLimitThenVoid() (gas: 653214) |
| E-touch-from | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Touch_RoundBeforeCreationOrNotCrossing_Pending() (gas: 655610) |
| E-touch-window | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Touch_RoundBeforeCreationOrNotCrossing_Pending() (gas: 655652) |
| E-sequencer-grace | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Sequencer_GraceBoundaryToTheSecond() (gas: 705134) |
| E-sequencer-down | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Sequencer_ReportedDownBlocksEvenWhenStartedLongAgo() (gas: 721958) |
| E-outcome-swap | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("panel outcome HOME")] test_Dispute_PanelSidesWithDisputer() (gas: 746679) |
| E-outcome-void | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("outcome 0 is VOID")] test_Outcome_FinalZeroEvaluatesToVoid() (gas: 382421) |
| E-pyth-conf | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: BadProof()] test_Pyth_AtDeadline_FirstUpdateAfterDeadline_AndFeeRefund() (gas: 545976) |
| E-threshold | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_ZeroThresholdRefused() (gas: 40439) |
| E-pairing | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_RegistryPairingAndMultiplier() (gas: 423101) |
| E-expiry-room | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_ExpiryMustCoverHoldWindow() (gas: 423238) |
| E-multiplier-snapshot | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_RegistryPairingAndMultiplier() (gas: 499236) |
| X-cap-amount | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] (fuzz test) |
| X-cap-counter | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_AboveReverts_AtCapPasses() (gas: 916891) |
| X-cap-accept | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_AcceptGated() (gas: 466932) |
| X-fee-kind | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("creation + resolver fee: 250000 != 750000")] test_ResolverFeeChargedForOutcome() (gas: 387785) |
| X-fee-create | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("creation + resolver fee: 250000 != 750000")] test_ResolverFeeChargedForOutcome() (gas: 387625) |
| X-fee-pull | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("router fee == reported fee: 0 != 2000000")] test_CreateWithAuthorization_SignedValueEqualsPulled_AndStaleFeeFails() (gas: 737931) |
| X-fee-auth | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("creation + resolver fee: 0 != 750000")] test_ResolverFeeChargedForOutcome() (gas: 355841) |
| X-fee-cap | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_OwnerHasNoPathToEscrowedFunds() (gas: 504085) |
| X-fee-total | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("batch pull == sum of amount + reported fee: 40000000 != 42100000")] test_CreateBatch_PullsSumOfAmountsAndReportedFees() (gas: 770148) |
| X-min-amount | `IfsoEscrow.sol` | KILLED | [FAIL: InvalidParams()|
| X-challenge-time | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_ChallengeShapeRules() (gas: 356215) |
| X-challenge-cancel | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_ChallengeShapeRules() (gas: 417174) |
| X-acceptby-expiry | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Challenge_AcceptByAtOrAfterExpiryRefused() (gas: 338885) |
| X-referee-sender | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Referee_CannotBeSenderOrRecipient() (gas: 316531) |
| X-referee-acceptor | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFromFailed() != BadRecipient()] test_Accept_RefereeAsAcceptor_Refused() (gas: 462030) |
| X-accept-window | `IfsoEscrow.sol` | KILLED | [FAIL: AcceptWindowClosed()] test_Accept_AllowedAtTheAcceptByInstant() (gas: 379673) |
| X-accept-self | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Accept_SenderOwnLinkChallenge_Refused() (gas: 481473) |
| X-accept-status | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("balance == obligations: 961553554 != 258720155")] invariant_BalanceMatchesObligations |
| X-accept-twice | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Accept_Twice_Reverts() (gas: 504438) |
| X-activefrom | `IfsoEscrow.sol` | EQUIVALENT |  |
| X-claim-sig | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_FrontRunnerCannotRedirect() (gas: 419692) |
| X-claim-twice | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_WrongKeyAndSecondClaimRevert() (gas: 591432) |
| X-settle-expired | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Settle_RefusedAtTheExpirySecond_RefundAllowed() (gas: 420646) |
| X-claim-expired | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_ClaimAfterExpiryReverts() (gas: 423592) |
| X-settle-unaccepted | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M1_AtDeadline_AcceptAfterResultKnown_MarketClosed() (gas: 790821) |
| X-ok-parties | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_DecideBySig_Eoa_And_Replay() (gas: 549416) |
| X-decline-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Parties_RecipientDeclineReturns_SenderCannotSelfRefund() (gas: 378762) |
| X-referee-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Referee_OnlyTwoPaths() (gas: 388483) |
| X-cancel-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cancel_OnlyWhenCancellable() (gas: 697873) |
| X-refund-addr-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 773823) |
| X-cancel-accepted | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_CancelOnlyBeforeAccept() (gas: 494147) |
| X-refund-early | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Refund_RefusedOneSecondBeforeExpiry() (gas: 398009) |
| X-refund-unaccepted | `IfsoEscrow.sol` | KILLED | [FAIL: NotExpired()] test_Unaccepted_RefundAfterAcceptWindow() (gas: 455452) |
| X-sig-deadline-decide | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_DecideBySig_Expired() (gas: 403977) |
| X-sig-deadline-refund | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_RefundRedirectBySig_ExpiredRefused() (gas: 425764) |
| X-nonce-decide | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: NoChange() != BadSignature()] test_DecideBySig_Eoa_And_Replay() (gas: 432188) |
| X-nonce-refund | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: NoChange() != BadSignature()] test_RefundRedirectBySig_SenderNeverTransacts() (gas: 456281) |
| X-release-to | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("to recipient: 1000000000000 != 1000020000000")] test_Referee_OnlyTwoPaths() (gas: 444970) |
| X-release-pot | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("everything exited: 1000000000 != 0")] test_Cap_LoweredDoesNotBlockExits() (gas: 2872127) |
| X-return-pot | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender side receives both stakes: 20000000 != 40000000")] test_NamedChallenge_RefereeToSender() (gas: 533436) |
| X-void-sides | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender own stake: 30000000 != 20000000")] test_PanelTimeout_VoidsAndBondsReturn_TwoSidedVoided() (gas: 935352) |
| X-void-alt | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("acceptor paid: 0 != 500000000")] test_R1_M4_OwedCounterSide_SenderPaid_AcceptorClaimsAlt() (gas: 723987) |
| X-no-alternate | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Refund_NoAlternateConfigured() (gas: 417036) |
| X-refund-self | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_RefundAddresses_EscrowItselfRefused() (gas: 378464) |
| X-paused | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Pause_GatesOnlyNewEntries() (gas: 886973) |
| X-maxamount-min | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_OnlyOwner() (gas: 105045) |
| R-dispute-window | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Dispute_AfterWindowReverts() (gas: 186593) |
| R-finalize-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_FinalizeOneSecondEarlyRefused() (gas: 297792) |
| R-panel-window | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas: 462462) |
| R-timeout-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas: 456574) |
| R-pot | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer receives both bonds: 100000000 != 200000000")] test_Dispute_PanelSidesWithDisputer() (gas: 768957) |
| R-winner | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer receives both bonds: 0 != 200000000")] test_Dispute_PanelSidesWithDisputer() (gas: 762007) |
| R-timeout-credit | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer bond back: 0 != 100000000")] test_PanelTimeout_VoidsAndBondsReturn_TwoSidedVoided() (gas: 944167) |
| R-creator | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_OnlyCreatorsRegisterQuestions_PanelChangeDelayed() (gas: 104279) |
| R-panel-only | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Dispute_PanelSidesWithDisputer() (gas: 608834) |
| R-withdraw-reset | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NothingToWithdraw()] test_Resolver_WithdrawBondOnlyOnce() (gas: 389935) |
| R-panel-delay | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelChangeNeedsTheFullDelay() (gas: 94422) |
| R-panel-apply | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_OnlyCreatorsRegisterQuestions_PanelChangeDelayed() (gas: 121664) |
| R-propose-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Undisputed_Finalize_Settles() (gas: 498829) |
| R-outcome-range | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_OutcomeAboveRangeRefused() (gas: 240695) |
| R-bond-snapshot | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer matches the snapshotted bond: 250000000 != 100000000")] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas: 376851) |
| F-treasury | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("work: 790000 != 800000")] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 362352) |
| F-perks | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("perks 5%: 60000 != 50000")] test_Distribute_80_10_5_5() (gas: 237023) |
| F-burn | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("burn 5%: 40000 != 50000")] test_Distribute_80_10_5_5() (gas: 244765) |
| F-dust | `FeeRouter.sol` | KILLED | [FAIL: TransferFailed()] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 324148) |
| F-sweep-usdg | `FeeRouter.sol` | KILLED | [FAIL: next call did not revert as expected] test_SweepCannotTouchUsdg() (gas: 52260) |
| F-recipients-zero | `FeeRouter.sol` | KILLED | [FAIL: next call did not revert as expected] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 85352) |
| O-accept-who | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_TwoStepOwnership_OnEveryOwnedContract() (gas: 123087) |
| O-only-owner | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 55439) |
| O-pending-clear | `utils/Owned2Step.sol` | KILLED | [FAIL: AssertionFailed("pending cleared")] test_TwoStepOwnership_OnEveryOwnedContract() (gas: 157485) |
| O-zero-owner | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_ZeroOwnerRefusedAtDeploy() (gas: 6437) |

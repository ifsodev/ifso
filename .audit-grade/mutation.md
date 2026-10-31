# Mutation score

Hand-written mutants (`contracts/tools/mutants.py`) are patched one at a time into a throwaway copy of
`contracts/src`; the default `forge test` suite (unit, fuzz and the short invariant profile) must fail.
Re-run: `python3 contracts/tools/mutation.py` (needs Foundry 1.8.4; about 8 minutes). A stale or non-compiling mutant fails the run.

**Total: 129/129 killed (100.0%)** (1 equivalent mutant(s) excluded, listed below)

| File | Killed | Total | Score |
|---|---|---|---|
| `IfsoConditionEvaluator.sol` | 40 | 40 | 100.0% |
| `IfsoEscrow.sol` | 57 | 57 | 100.0% |
| `IfsoOutcomeResolver.sol` | 19 | 19 | 100.0% |
| `FeeRouter.sol` | 9 | 9 | 100.0% |
| `utils/Owned2Step.sol` | 4 | 4 | 100.0% |

## Review finding mutants (each undoes one fix)

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
| R2-I1-a | R2-I1 | the starvation bound ignores the USDG proxy's second frame | KILLED |
| M4-d | R1-M4 | claimVoid does not clear the owed flag (double payout) | KILLED |
| M4-e | R1-M4 | claimVoid works on a side that is not owed | KILLED |
| M4-f | R1-M4 | an owed sender side can no longer redirect its refund | KILLED |
| M4-g | R1-M4 | an owed acceptor side can no longer redirect its refund | KILLED |
| M4-h | R1-M4 | refund addresses can change after the escrow is closed | KILLED |
| M4-i | R1-M4 | owed flag is set on the wrong side (sender paid owed as counter) | KILLED |
| M5-a | R1-M5 | a repeated OK is accepted again (relayer-paid no-op) | KILLED |
| M5-b | R1-M5 | re-setting the same refund addresses is accepted again | KILLED |
| L1-a | R1-L1 | a change still pending at settle VOIDs a decided result | KILLED |
| L1-b | R1-L1 | a change in force before the deciding round no longer VOIDs | KILLED |
| L1-c | R1-L1 | an unscheduled multiplier change is accepted | KILLED |
| L1-e | R1-L1 | an unreadable multiplier no longer fails closed | KILLED |
| L1-f | R1-L1 | a schedule in force from the deciding round's exact second is not trusted | KILLED |
| R2-L1-a | R2-L1 | a change in force between the deciding price and settle passes (two actions fail open) | KILLED |
| R2-L1-b | R2-L1 | a change taking effect at the settle's exact second passes | KILLED |
| R2-L1-c | R2-L1 | a pending schedule hides a current value that differs from the snapshot | KILLED |
| R2-L1-d | R2-L1 | a token reporting a value other than its in-force schedule is trusted | KILLED |
| R2-L1-e | R2-L1 | an unreadable effectiveAt is read as no schedule again | KILLED |
| R2-L1-f | R2-L1 | an unreadable newUIMultiplier is read as 0 | KILLED |
| R2-L2-a | R2-L2 | OUTCOME expiry ignores the late-proposal grace | KILLED |
| R2-L2-b | R2-L2 | the late-proposal grace is shortened | KILLED |
| R2-L2-c | R2-L2 | the late-proposal grace outgrows the app's 7-day window | KILLED |

## Survivors

None.

## Equivalent mutants (no observable behaviour change)

- X-activefrom (`IfsoEscrow.sol`): activeFrom only feeds TOUCH windows and two-sided TOUCH is refused (R1-M2)

## All mutants

| Mutant | File | Result | First failing test |
|---|---|---|---|
| M1-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Challenge_AcceptByPlusMaxStaleEqualDeadline_Refused() (gas: 445160) |
| M1-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadlineChallenge_AcceptByMustPrecedeDeadline() (gas: 439980) |
| M2-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_TouchChallenge_RefusedAtCreation() (gas: 439824) |
| M3-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M3_Outcome_DisputeRunsOutTheClock() (gas: 567468) |
| M3-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R2_L2_LateProposal_DisputeStillRunsOutTheClock() (gas: 573238) |
| M3-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R2_L2_LateProposal_DisputeStillRunsOutTheClock() (gas: 574642) |
| M4-a | `IfsoEscrow.sol` | KILLED | [FAIL: EvmError: Revert] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 588347) |
| M4-b | `IfsoEscrow.sol` | KILLED | [FAIL: EvmError: Revert] test_Void_OwedAcceptorSide_CanRedirectThenIsPaid() (gas: 549601) |
| M4-c | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("starved side marked owed: 32 != 0")] test_R2_I1_ProxyUsdg_StarvedRefundNeverMarksAPayableSideOwe |
| R2-I1-a | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("starved side marked owed: 32 != 0")] test_R2_I1_ProxyUsdg_StarvedRefundNeverMarksAPayableSideOwe |
| M4-d | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas |
| M4-e | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas |
| M4-f | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 803039) |
| M4-g | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_Void_OwedAcceptorSide_CanRedirectThenIsPaid() (gas: 615387) |
| M4-h | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 1010336) |
| M4-i | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender side owed: 0 != 32")] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 630861) |
| M5-a | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M5_NoOpRevertsNoChange_RealChangesStillWork() (gas: 400976) |
| M5-b | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M5_NoOpRevertsNoChange_RealChangesStillWork() (gas: 539936) |
| L1-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("deadline price was pre-split and decided: should release")] test_R1_L1_PendingSplitAfterDeadline |
| L1-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("decided on a re-based price: 17571 != 1000000000000000000") |
| L1-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("VOID on corporate action")] test_MultiplierChange_Voids() (gas: 721063) |
| L1-e | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("VOID, not RELEASED, when the multiplier is unreadable")] test_Multiplier_UnreadableFailsClosedTo |
| L1-f | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("snapshot in force at the price")] test_R2_L1_ProvablyUnchangedStillDecides() (gas: 1349635) |
| R2-L1-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("decided on a re-based price: 535945481238622838 != 1000000000000000000") |
| R2-L1-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("lazy token, change in force: VOID")] test_R2_L1_ActionInForceBeforeSettle_Voids() (gas: 1104699) |
| R2-L1-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("decided on a re-based price: 7584007913129639933 != 1000000000000000000") |
| R2-L1-d | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("uiMultiplier != newUIMultiplier: VOID")] test_R2_L1_InconsistentToken_Voids() (gas: 767040) |
| R2-L1-e | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("effectiveAt unreadable: VOID")] test_R2_L1_UnreadableSchedule_Voids() (gas: 1031218) |
| R2-L1-f | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("newUIMultiplier unreadable: VOID")] test_R2_L1_UnreadableSchedule_Voids() (gas: 1222783) |
| R2-L2-a | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_R2_L2_LateProposal_DisputeStillRunsOutTheClock() (gas: 493261) |
| R2-L2-b | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("covers the review's 30 h late sources: 86400 != 172800")] test_R2_L2_LateProposal_DisputeStillRu |
| R2-L2-c | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("covers the review's 30 h late sources: 259200 != 172800")] test_R2_L2_LateProposal_DisputeStillR |
| E-cross-gte | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("inclusive comparators")] test_AtDeadline_EqualityCountsForGteAndLte() (gas: 1179866) |
| E-cross-lte | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("inclusive comparators")] test_AtDeadline_EqualityCountsForGteAndLte() (gas: 1203500) |
| E-time | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_CreateBatch_PayrollRun() (gas: 811496) |
| E-after-deadline | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_NotSettleableAtTheDeadlineSecond() (gas: 670738) |
| E-round-after | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_AtDeadline_EarlierRoundIsNotLastWhenNextIsAtTheDeadline() (gas: 786621) |
| E-last-round | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_EarlierRoundIsNotLastWhenNextIsAtTheDeadline() (gas: 767665 |
| E-stale | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: ConditionPending()] test_AtDeadline_RoundExactlyMaxStaleOldIsFresh() (gas: 623409) |
| E-hold | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("decided on the print at the limit")] test_AtDeadline_PrintExactlyAtTheHoldLimitDecides() (gas: 7 |
| E-hold-wait | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_AtDeadline_NoPrint_PendingUntilTheHoldLimitThenVoid() (gas: 653192) |
| E-touch-from | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Touch_RoundBeforeCreationOrNotCrossing_Pending() (gas: 655523) |
| E-touch-window | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Touch_RoundBeforeCreationOrNotCrossing_Pending() (gas: 655565) |
| E-sequencer-grace | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Sequencer_GraceBoundaryToTheSecond() (gas: 705047) |
| E-sequencer-down | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Sequencer_ReportedDownBlocksEvenWhenStartedLongAgo() (gas: 721871) |
| E-outcome-swap | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("panel outcome HOME")] test_Dispute_PanelSidesWithDisputer() (gas: 746753) |
| E-outcome-void | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: AssertionFailed("outcome 0 is VOID")] test_Outcome_FinalZeroEvaluatesToVoid() (gas: 382421) |
| E-pyth-conf | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: BadProof()] test_Pyth_AtDeadline_FirstUpdateAfterDeadline_AndFeeRefund() (gas: 545954) |
| E-threshold | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_ZeroThresholdRefused() (gas: 40417) |
| E-pairing | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_RegistryPairingAndMultiplier() (gas: 423079) |
| E-expiry-room | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_ExpiryMustCoverHoldWindow() (gas: 423216) |
| E-multiplier-snapshot | `IfsoConditionEvaluator.sol` | KILLED | [FAIL: next call did not revert as expected] test_Validate_RegistryPairingAndMultiplier() (gas: 499192) |
| X-cap-amount | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected |
| X-cap-counter | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_AboveReverts_AtCapPasses() (gas: 916825) |
| X-cap-accept | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_AcceptGated() (gas: 466910) |
| X-fee-kind | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("creation + resolver fee: 250000 != 750000")] test_ResolverFeeChargedForOutcome() (gas: 387859) |
| X-fee-create | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("batch pull == sum of amount + reported fee: 41200000 != 42100000")] test_CreateBatch_PullsSumOfA |
| X-fee-pull | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("router fee == reported fee: 0 != 2000000")] test_CreateWithAuthorization_SignedValueEqualsPulled |
| X-fee-auth | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("both stakes held: 40250000 != 40000000")] test_Accept_AllowedAtTheAcceptByInstant() (gas: 420068 |
| X-fee-cap | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_OwnerHasNoPathToEscrowedFunds() (gas: 504063) |
| X-fee-total | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("batch pull == sum of amount + reported fee: 40000000 != 42100000")] test_CreateBatch_PullsSumOfA |
| X-min-amount | `IfsoEscrow.sol` | KILLED | [FAIL: InvalidParams() |
| X-challenge-time | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_ChallengeShapeRules() (gas: 356193) |
| X-challenge-cancel | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_ChallengeShapeRules() (gas: 417152) |
| X-acceptby-expiry | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Challenge_AcceptByAtOrAfterExpiryRefused() (gas: 338863) |
| X-referee-sender | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Referee_CannotBeSenderOrRecipient() (gas: 316509) |
| X-referee-acceptor | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: TransferFromFailed() != BadRecipient()] test_Accept_RefereeAsAcceptor_Refused() (gas: 46 |
| X-accept-window | `IfsoEscrow.sol` | KILLED | [FAIL: AcceptWindowClosed()] test_Accept_AllowedAtTheAcceptByInstant() (gas: 379651) |
| X-accept-self | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Accept_SenderOwnLinkChallenge_Refused() (gas: 481451) |
| X-accept-status | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("everything owed went out: 88914472 != 87914310")] invariant_BalanceMatchesObligations |
| X-accept-twice | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Accept_Twice_Reverts() (gas: 504416) |
| X-activefrom | `IfsoEscrow.sol` | EQUIVALENT |  |
| X-claim-sig | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_FrontRunnerCannotRedirect() (gas: 419670) |
| X-claim-twice | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_WrongKeyAndSecondClaimRevert() (gas: 591410) |
| X-settle-expired | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Settle_RefusedAtTheExpirySecond_RefundAllowed() (gas: 420624) |
| X-claim-expired | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Link_ClaimAfterExpiryReverts() (gas: 423570) |
| X-settle-unaccepted | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M1_AtDeadline_AcceptAfterResultKnown_MarketClosed() (gas: 790712) |
| X-ok-parties | `IfsoEscrow.sol` | KILLED | [FAIL: NotOpen()] test_DecideBySig_Eoa_And_Replay() (gas: 549394) |
| X-decline-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Parties_RecipientDeclineReturns_SenderCannotSelfRefund() (gas: 378740) |
| X-referee-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Referee_OnlyTwoPaths() (gas: 388461) |
| X-cancel-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cancel_OnlyWhenCancellable() (gas: 697829) |
| X-refund-addr-who | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_R1_M4_OwedSenderSide_RedirectThenAnyoneClaims() (gas: 773801) |
| X-cancel-accepted | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_CancelOnlyBeforeAccept() (gas: 494125) |
| X-refund-early | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Refund_RefusedOneSecondBeforeExpiry() (gas: 397987) |
| X-refund-unaccepted | `IfsoEscrow.sol` | KILLED | [FAIL: NotExpired()] test_Unaccepted_RefundAfterAcceptWindow() (gas: 455430) |
| X-sig-deadline-decide | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_DecideBySig_Expired() (gas: 403955) |
| X-sig-deadline-refund | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_RefundRedirectBySig_ExpiredRefused() (gas: 425742) |
| X-nonce-decide | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: NoChange() != BadSignature()] test_DecideBySig_Eoa_And_Replay() (gas: 432166) |
| X-nonce-refund | `IfsoEscrow.sol` | KILLED | [FAIL: Error != expected error: NoChange() != BadSignature()] test_RefundRedirectBySig_SenderNeverTransacts() (gas: 4562 |
| X-release-to | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("to recipient: 1000000000000 != 1000020000000")] test_Referee_OnlyTwoPaths() (gas: 444948) |
| X-release-pot | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("recipient receives both stakes in full: 20000000 != 40000000")] test_NamedChallenge_RefereeToRec |
| X-return-pot | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender side receives both stakes: 20000000 != 40000000")] test_NamedChallenge_RefereeToSender()  |
| X-void-sides | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("sender own stake: 30000000 != 20000000")] test_PanelTimeout_VoidsAndBondsReturn_TwoSidedVoided() |
| X-void-alt | `IfsoEscrow.sol` | KILLED | [FAIL: AssertionFailed("acceptor paid: 0 != 500000000")] test_R1_M4_OwedCounterSide_SenderPaid_AcceptorClaimsAlt() (gas: |
| X-no-alternate | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Refund_NoAlternateConfigured() (gas: 417014) |
| X-refund-self | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_RefundAddresses_EscrowItselfRefused() (gas: 378442) |
| X-paused | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Pause_GatesOnlyNewEntries() (gas: 886907) |
| X-maxamount-min | `IfsoEscrow.sol` | KILLED | [FAIL: next call did not revert as expected] test_Cap_OnlyOwner() (gas: 105045) |
| R-dispute-window | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Dispute_AfterWindowReverts() (gas: 186593) |
| R-finalize-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_FinalizeOneSecondEarlyRefused() (gas: 297792) |
| R-panel-window | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas: 462462) |
| R-timeout-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas: 456574) |
| R-pot | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer receives both bonds: 100000000 != 200000000")] test_Dispute_PanelSidesWithDisputer() (g |
| R-winner | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer receives both bonds: 0 != 200000000")] test_Dispute_PanelSidesWithDisputer() (gas: 7620 |
| R-timeout-credit | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer bond back: 0 != 100000000")] test_Resolver_PanelWindowBoundaries_AndBondSnapshot() (gas |
| R-creator | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_OnlyCreatorsRegisterQuestions_PanelChangeDelayed() (gas: 104279) |
| R-panel-only | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Dispute_PanelSidesWithDisputer() (gas: 608908) |
| R-withdraw-reset | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: Error != expected error: TransferFailed() != NothingToWithdraw()] test_Resolver_WithdrawBondOnlyOnce() (gas: 3899 |
| R-panel-delay | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelChangeNeedsTheFullDelay() (gas: 94422) |
| R-panel-apply | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_PanelChangeNeedsTheFullDelay() (gas: 94262) |
| R-propose-early | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Undisputed_Finalize_Settles() (gas: 498903) |
| R-outcome-range | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: next call did not revert as expected] test_Resolver_OutcomeAboveRangeRefused() (gas: 240695) |
| R-bond-snapshot | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("disputer matches the snapshotted bond: 250000000 != 100000000")] test_Resolver_PanelWindowBounda |
| F-treasury | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("work: 790000 != 800000")] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 362352) |
| F-perks | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("perks 5%: 60000 != 50000")] test_Distribute_80_10_5_5() (gas: 237023) |
| F-burn | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("burn 5%: 40000 != 50000")] test_Distribute_80_10_5_5() (gas: 244765) |
| F-dust | `FeeRouter.sol` | KILLED | [FAIL: TransferFailed()] test_Distribute_80_10_5_5() (gas: 192169) |
| F-sweep-usdg | `FeeRouter.sol` | KILLED | [FAIL: next call did not revert as expected] test_SweepCannotTouchUsdg() (gas: 52260) |
| F-recipients-zero | `FeeRouter.sol` | KILLED | [FAIL: next call did not revert as expected] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 85352) |
| O-accept-who | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_TwoStepOwnership_OnEveryOwnedContract() (gas: 123087) |
| O-only-owner | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 55439) |
| O-pending-clear | `utils/Owned2Step.sol` | KILLED | [FAIL: AssertionFailed("pending cleared")] test_TwoStepOwnership_OnEveryOwnedContract() (gas: 157485) |
| O-zero-owner | `utils/Owned2Step.sol` | KILLED | [FAIL: next call did not revert as expected] test_ZeroOwnerRefusedAtDeploy() (gas: 6437) |
| INV-OR1-withdraw | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("bond returned: 99999999 != 100000000")] test_Undisputed_Finalize_Settles() (gas: 879012) |
| INV-OR2-refinalize | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: ConditionPending()] test_OtherOutcome_Returns() (gas: 596985) |
| INV-OR3-timeout-party | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("proposer bond back: 200000000 != 100000000")] test_PanelTimeout_VoidsAndBondsReturn_TwoSidedVoid |
| INV-OR4-repropose | `IfsoOutcomeResolver.sol` | KILLED | [FAIL: AssertionFailed("OR4: a question moved backwards or left a terminal state")] invariant_ResolverStatesOnlyMoveForw |
| INV-FR1-leak | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("burn: 0 != 50000")] test_Router_SetRecipients_OwnerOnly_NoZero() (gas: 379442) |
| INV-FR2-misroute | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("treasury 10%: 0 != 100000")] test_Distribute_80_10_5_5() (gas: 201022) |
| INV-FR3-stuck | `FeeRouter.sol` | KILLED | [FAIL: AssertionFailed("work 80% + dust: 800000 != 800001")] test_Distribute_80_10_5_5() (gas: 253542) |

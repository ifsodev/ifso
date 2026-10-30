// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IIfsoOutcomeResolver {
    enum State {
        NONE,
        OPEN, //      registered, no proposal yet
        PROPOSED, //  bonded proposal inside the dispute window
        DISPUTED, //  escalated to the fallback panel
        FINAL, //     outcome settled (outcome 0 = VOID: postponed / abandoned / invalid)
        VOID //       panel timed out -> treated as VOID by escrows
    }

    event QuestionCreated(
        bytes32 indexed questionId,
        bytes32 specHash,
        uint64 closeTime,
        uint64 earliestResolve,
        uint8 numOutcomes,
        string specURI
    );
    event Proposed(
        bytes32 indexed questionId, address indexed proposer, uint8 outcome, bytes32 sourcesHash, uint96 bond
    );
    event Disputed(bytes32 indexed questionId, address indexed disputer, bytes32 evidenceHash);
    event Finalized(bytes32 indexed questionId, uint8 outcome, bool byPanel);
    event PanelTimedOut(bytes32 indexed questionId);
    event BondCredited(address indexed account, uint256 amount);
    event BondWithdrawn(address indexed account, address indexed to, uint256 amount);

    function outcomeOf(bytes32 questionId) external view returns (State state, uint8 outcome);
    /// @notice closeTime = when the answer starts to be knowable (kickoff / market close); challenges must be
    ///         accepted before it
    function questionInfo(bytes32 questionId)
        external
        view
        returns (State state, uint8 numOutcomes, uint64 closeTime, uint64 earliestResolve);
    function disputeWindow() external view returns (uint64);
    function panelWindow() external view returns (uint64);
}

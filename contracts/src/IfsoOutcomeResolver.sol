// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IIfsoOutcomeResolver} from "./interfaces/IIfsoOutcomeResolver.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title  IfsoOutcomeResolver
/// @notice Bonded optimistic resolver for sports results and prediction-market resolutions on Robinhood
///         Chain (UMA OOv3, Reality.eth and Chainlink CRE are not deployed on RHC mainnet as of 2026-10-25).
///
///         Flow: a curated question is registered with a spec hash (rules: "90 minutes + stoppage time",
///         "postponed/abandoned => VOID", which market and outcome index, ...). After `earliestResolve`, ANYONE
///         may propose an outcome by posting `bondAmount` USDG (the studio resolver service normally does so
///         from >= 2 agreeing independent sources, committing their hash as `sourcesHash`). During the dispute
///         window ANYONE may dispute by matching the bond. Undisputed => FINAL with the proposed outcome.
///         Disputed => the fallback panel (a Safe multisig) picks the outcome within `panelWindow`; the side the
///         panel agrees with gets its own bond back plus half the loser's; the loser's other half goes to the
///         FeeRouter (audit M-1: a self-dispute through a second address costs at least bond / 2). Panel silent =>
///         VOID (escrows refund) and each side gets only half its bond back; the other halves go to the FeeRouter,
///         so a dispute nobody answers is never free. A proposer cannot dispute its own proposal.
///
///         Outcome 0 is always VOID (postponed / abandoned / invalid / ambiguous). Bonds are paid by pull
///         (`withdrawBond`) so a screened or blocklisted address cannot block finalization.
///         Owner (brand multisig) powers: bond size within fixed bounds, question creators, and the panel
///         address behind a 48 h delay. None of them touch posted bonds or any escrowed payment.
contract IfsoOutcomeResolver is IIfsoOutcomeResolver, Owned2Step, ReentrancyGuard {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------ errors
    error NotCreator();
    error NotPanel();
    error BadQuestion();
    error WrongState();
    error TooEarly();
    error WindowClosed();
    error BadOutcome();
    error BondOutOfBounds();
    error NothingToWithdraw();
    error NoPendingPanel();
    error SelfDispute();

    // ------------------------------------------------------------------ events
    event CreatorSet(address indexed creator, bool allowed);
    event BondAmountSet(uint96 bondAmount);
    event PanelChangeQueued(address indexed panel, uint64 executableAt);
    event PanelChanged(address indexed panel);
    event BondForfeited(bytes32 indexed questionId, uint256 amount);
    event ForfeitsForwarded(address indexed feeRouter, uint256 amount);

    struct Question {
        bytes32 specHash;
        bytes32 sourcesHash;
        address proposer;
        uint96 bond;
        address disputer;
        uint64 closeTime;
        uint64 earliestResolve;
        uint64 proposedAt;
        uint64 disputedAt;
        uint8 numOutcomes;
        uint8 proposed;
        uint8 finalOutcome;
        State state;
    }

    // ------------------------------------------------------------------ config
    uint96 public constant MIN_BOND = 10e6; //     10 USDG
    uint96 public constant MAX_BOND = 10_000e6; // 10,000 USDG
    uint64 public constant PANEL_CHANGE_DELAY = 48 hours;
    uint8 public constant MAX_OUTCOMES = 32;

    address public immutable bondToken; // USDG
    address public immutable feeRouter; // receives forfeited bond halves (FeeRouter, 80/10/5/5)
    uint64 public immutable override disputeWindow; // e.g. 2 hours
    uint64 public immutable override panelWindow; //   e.g. 72 hours

    uint96 public bondAmount;
    address public panel;
    address public pendingPanel;
    uint64 public pendingPanelAt;

    mapping(address => bool) public isCreator;
    mapping(bytes32 => Question) internal _q;
    mapping(address => uint256) public claimableBond;
    uint256 public forfeited; // forfeited bond halves not yet forwarded to feeRouter

    constructor(
        address owner_,
        address bondToken_,
        uint64 disputeWindow_,
        uint64 panelWindow_,
        uint96 bond_,
        address panel_,
        address feeRouter_
    ) Owned2Step(owner_) {
        if (bondToken_ == address(0) || panel_ == address(0) || feeRouter_ == address(0)) revert ZeroAddress();
        if (disputeWindow_ < 30 minutes || disputeWindow_ > 7 days) revert BadQuestion();
        if (panelWindow_ < 1 days || panelWindow_ > 14 days) revert BadQuestion();
        if (bond_ < MIN_BOND || bond_ > MAX_BOND) revert BondOutOfBounds();
        bondToken = bondToken_;
        feeRouter = feeRouter_;
        disputeWindow = disputeWindow_;
        panelWindow = panelWindow_;
        bondAmount = bond_;
        panel = panel_;
    }

    // ------------------------------------------------------------------ admin
    /// @notice Allows or removes a service key that may register questions.
    /// @param creator Service key allowed to register questions.
    /// @param allowed true allows the key, false removes it (questions already registered are unaffected).
    function setCreator(address creator, bool allowed) external onlyOwner {
        isCreator[creator] = allowed;
        emit CreatorSet(creator, allowed);
    }

    /// @notice Sets the bond for NEW proposals and disputes.
    /// @param bond_ New bond in USDG base units (within MIN_BOND..MAX_BOND).
    function setBondAmount(uint96 bond_) external onlyOwner {
        if (bond_ < MIN_BOND || bond_ > MAX_BOND) revert BondOutOfBounds();
        bondAmount = bond_; // proposals already posted keep their snapshotted bond
        emit BondAmountSet(bond_);
    }

    /// @notice Queues a new fallback panel; it takes effect only after PANEL_CHANGE_DELAY (48 h).
    /// @param newPanel Panel multisig that takes over after PANEL_CHANGE_DELAY.
    function queuePanel(address newPanel) external onlyOwner {
        if (newPanel == address(0)) revert ZeroAddress();
        pendingPanel = newPanel;
        pendingPanelAt = uint64(block.timestamp) + PANEL_CHANGE_DELAY;
        emit PanelChangeQueued(newPanel, pendingPanelAt);
    }

    /// @notice Anyone applies a queued panel change once its delay has passed.
    function applyPanel() external {
        if (pendingPanel == address(0)) revert NoPendingPanel();
        if (block.timestamp < pendingPanelAt) revert TooEarly();
        panel = pendingPanel;
        pendingPanel = address(0);
        pendingPanelAt = 0;
        emit PanelChanged(panel);
    }

    // ------------------------------------------------------------------ questions
    /// @notice questionId = keccak256(abi.encode(specHash, closeTime, earliestResolve, numOutcomes)).
    /// @param closeTime       when the answer starts to be knowable (kickoff, market close)
    /// @param earliestResolve earliest proposal time (e.g. scheduled full time + buffer)
    /// @param specHash keccak256 of the question spec document.
    /// @param numOutcomes Number of outcomes (2..MAX_OUTCOMES); outcome 0 is VOID.
    /// @param specURI Where the question spec is published.
    function createQuestion(
        bytes32 specHash,
        uint64 closeTime,
        uint64 earliestResolve,
        uint8 numOutcomes,
        string calldata specURI
    ) external returns (bytes32 questionId) {
        if (!isCreator[msg.sender]) revert NotCreator();
        if (specHash == bytes32(0) || numOutcomes < 2 || numOutcomes > MAX_OUTCOMES) revert BadQuestion();
        if (closeTime <= block.timestamp || earliestResolve < closeTime) revert BadQuestion();
        questionId = keccak256(abi.encode(specHash, closeTime, earliestResolve, numOutcomes));
        Question storage q = _q[questionId];
        if (q.state != State.NONE) revert BadQuestion();
        q.specHash = specHash;
        q.closeTime = closeTime;
        q.earliestResolve = earliestResolve;
        q.numOutcomes = numOutcomes;
        q.state = State.OPEN;
        emit QuestionCreated(questionId, specHash, closeTime, earliestResolve, numOutcomes, specURI);
    }

    /// @notice Anyone may propose after earliestResolve by posting the bond.
    /// @param sourcesHash hash of the evidence bundle (provider ids, fetched-at times, response digests)
    /// @param questionId Question id (see questionIdFor).
    /// @param outcome Outcome index proposed or decided.
    function propose(bytes32 questionId, uint8 outcome, bytes32 sourcesHash) external nonReentrant {
        Question storage q = _q[questionId];
        if (q.state != State.OPEN) revert WrongState();
        if (block.timestamp < q.earliestResolve) revert TooEarly();
        if (outcome > q.numOutcomes) revert BadOutcome();
        uint96 bond = bondAmount;
        q.state = State.PROPOSED;
        q.proposer = msg.sender;
        q.proposed = outcome;
        q.bond = bond;
        q.sourcesHash = sourcesHash;
        q.proposedAt = uint64(block.timestamp);
        bondToken.safeTransferFrom(msg.sender, address(this), bond);
        emit Proposed(questionId, msg.sender, outcome, sourcesHash, bond);
    }

    /// @notice Anyone except the proposer may dispute inside the window by matching the proposer's bond.
    /// @param questionId Question id (see questionIdFor).
    /// @param evidenceHash keccak256 of the disputer's evidence.
    function dispute(bytes32 questionId, bytes32 evidenceHash) external nonReentrant {
        Question storage q = _q[questionId];
        if (q.state != State.PROPOSED) revert WrongState();
        if (block.timestamp >= uint256(q.proposedAt) + disputeWindow) revert WindowClosed();
        if (msg.sender == q.proposer) revert SelfDispute();
        q.state = State.DISPUTED;
        q.disputer = msg.sender;
        q.disputedAt = uint64(block.timestamp);
        bondToken.safeTransferFrom(msg.sender, address(this), q.bond);
        emit Disputed(questionId, msg.sender, evidenceHash);
    }

    /// @notice Anyone finalizes an undisputed proposal once the window has passed.
    /// @param questionId Question id (see questionIdFor).
    function finalize(bytes32 questionId) external {
        Question storage q = _q[questionId];
        if (q.state != State.PROPOSED) revert WrongState();
        if (block.timestamp < uint256(q.proposedAt) + disputeWindow) revert TooEarly();
        q.state = State.FINAL;
        q.finalOutcome = q.proposed;
        _credit(q.proposer, q.bond);
        emit Finalized(questionId, q.proposed, false);
    }

    /// @notice Fallback panel decides a disputed question (outcome 0 = VOID allowed). The side it agrees with gets
    ///         its bond plus half the loser's; the loser's other half is forfeited to the FeeRouter.
    /// @param questionId Question id (see questionIdFor).
    /// @param outcome Outcome index proposed or decided.
    function panelResolve(bytes32 questionId, uint8 outcome) external {
        if (msg.sender != panel) revert NotPanel();
        Question storage q = _q[questionId];
        if (q.state != State.DISPUTED) revert WrongState();
        if (block.timestamp >= uint256(q.disputedAt) + panelWindow) revert WindowClosed();
        if (outcome > q.numOutcomes) revert BadOutcome();
        q.state = State.FINAL;
        q.finalOutcome = outcome;
        uint256 bond = q.bond;
        uint256 lost = bond - bond / 2; // loser's forfeited half, rounded up
        _credit(outcome == q.proposed ? q.proposer : q.disputer, bond * 2 - lost);
        _forfeit(questionId, lost);
        emit Finalized(questionId, outcome, true);
    }

    /// @notice Anyone voids a disputed question the panel did not decide in time; each side gets half its bond
    ///         back and the other halves are forfeited to the FeeRouter.
    /// @param questionId Question id (see questionIdFor).
    function finalizeTimedOut(bytes32 questionId) external {
        Question storage q = _q[questionId];
        if (q.state != State.DISPUTED) revert WrongState();
        if (block.timestamp < uint256(q.disputedAt) + panelWindow) revert TooEarly();
        q.state = State.VOID;
        uint256 half = q.bond / 2;
        _credit(q.proposer, half);
        _credit(q.disputer, half);
        _forfeit(questionId, (uint256(q.bond) - half) * 2);
        emit PanelTimedOut(questionId);
    }

    /// @notice Withdraws the caller's claimable bonds and rewards.
    /// @param to Where the claimable bonds are sent.
    function withdrawBond(address to) external nonReentrant {
        uint256 amt = claimableBond[msg.sender];
        if (amt == 0) revert NothingToWithdraw();
        claimableBond[msg.sender] = 0;
        bondToken.safeTransfer(to == address(0) ? msg.sender : to, amt);
        emit BondWithdrawn(msg.sender, to == address(0) ? msg.sender : to, amt);
    }

    /// @notice Anyone forwards the forfeited bond halves to the FeeRouter.
    function forwardForfeits() external nonReentrant {
        uint256 amt = forfeited;
        if (amt == 0) revert NothingToWithdraw();
        forfeited = 0;
        bondToken.safeTransfer(feeRouter, amt);
        emit ForfeitsForwarded(feeRouter, amt);
    }

    function _forfeit(bytes32 questionId, uint256 amt) private {
        forfeited += amt;
        emit BondForfeited(questionId, amt);
    }

    function _credit(address who, uint256 amt) private {
        claimableBond[who] += amt;
        emit BondCredited(who, amt);
    }

    // ------------------------------------------------------------------ views
    /// @notice Current state and outcome of a question.
    /// @param questionId Question id (see questionIdFor).
    function outcomeOf(bytes32 questionId) external view returns (State state, uint8 outcome) {
        Question storage q = _q[questionId];
        return (q.state, q.finalOutcome);
    }

    /// @notice State, outcome, close time and earliest-resolve time of a question.
    /// @param questionId Question id (see questionIdFor).
    function questionInfo(bytes32 questionId) external view returns (State, uint8, uint64, uint64) {
        Question storage q = _q[questionId];
        return (q.state, q.numOutcomes, q.closeTime, q.earliestResolve);
    }

    /// @notice Full question record.
    /// @param questionId Question id (see questionIdFor).
    function getQuestion(bytes32 questionId) external view returns (Question memory) {
        return _q[questionId];
    }

    /// @notice Deterministic question id from its spec and timing.
    /// @param specHash keccak256 of the question spec document.
    /// @param closeTime When the question closes for new escrows.
    /// @param earliestResolve Earliest time a result may be proposed.
    /// @param numOutcomes Number of outcomes (2..MAX_OUTCOMES); outcome 0 is VOID.
    function questionIdFor(bytes32 specHash, uint64 closeTime, uint64 earliestResolve, uint8 numOutcomes)
        external
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(specHash, closeTime, earliestResolve, numOutcomes));
    }
}

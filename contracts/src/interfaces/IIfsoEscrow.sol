// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Condition, CreateParams, Status, Verdict, Kind} from "../libraries/IfsoTypes.sol";

interface IIfsoEscrow {
    struct Escrow {
        address sender;
        uint96 amount;
        address recipient; // bound recipient (0 until a link is claimed / challenge accepted)
        uint96 counterAmount;
        address linkKey;
        uint64 activeFrom; // creation time; for challenges, reset to the acceptance time
        Status status;
        uint8 flags;
        address refundTo;
        uint64 expiry;
        address altRefundTo;
        uint64 acceptBy;
        address counterRefundTo;
        bytes32 conditionHash;
    }

    // ---------------------------------------------------------------- events
    event Created(
        uint256 indexed id,
        address indexed sender,
        address indexed recipient,
        address linkKey,
        uint96 amount,
        uint96 counterAmount,
        Kind kind,
        bytes32 conditionHash,
        uint64 expiry,
        bool twoSided,
        uint96 feePaid
    );
    event Accepted(uint256 indexed id, address indexed acceptor, address counterRefundTo);
    event Claimed(uint256 indexed id, address indexed recipient);
    event Approved(uint256 indexed id, address indexed party);
    event Declined(uint256 indexed id, address indexed recipient);
    event RefereeDecided(uint256 indexed id, address indexed referee, bool toRecipient);
    event Met(uint256 indexed id);
    event Released(uint256 indexed id, address indexed to, uint256 amount);
    event Returned(uint256 indexed id, address indexed to, uint256 amount, uint8 reason);
    event Voided(uint256 indexed id, address senderTo, uint256 senderAmount, address counterTo, uint256 counterAmount);
    event Cancelled(uint256 indexed id, address indexed to, uint256 amount);
    event RefundAddressesChanged(uint256 indexed id, address refundTo, address altRefundTo);
    event CounterRefundChanged(uint256 indexed id, address counterRefundTo);
    /// @notice A VOIDED side that could not be paid at void time (Voided reported its destination as 0) was paid.
    event VoidClaimed(uint256 indexed id, address indexed to, uint256 amount);
    event FeesUpdated(uint96 creationFee, uint96 resolverFee);
    event CreationPaused(bool paused);
    event MaxAmountUpdated(uint96 maxAmount);

    // ---------------------------------------------------------------- errors
    error CreationIsPaused();
    error InvalidParams();
    error AlreadyExists();
    error NotOpen();
    error Expired();
    error NotExpired();
    error NotALink();
    error AlreadyClaimed();
    error BadSignature();
    error BadRecipient();
    error NotTwoSided();
    error NotAccepted();
    error AlreadyAccepted();
    error AcceptWindowClosed();
    error ConditionPending();
    error UseDecision();
    error NotAuthorized();
    error NotCancellable();
    error NoAlternate();
    error SignatureExpired();
    error FeeTooHigh();
    error AmountAboveCap();
    error NoChange();

    // ---------------------------------------------------------------- views
    function getEscrow(uint256 id) external view returns (Escrow memory);
    function getCondition(uint256 id) external view returns (Condition memory);
    function idFor(address sender, bytes32 salt) external pure returns (uint256);
    function feeFor(Kind kind) external view returns (uint96);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {
    Condition,
    CreateParams,
    Kind,
    Status,
    Verdict,
    APPROVE_PARTIES,
    APPROVE_REFEREE
} from "./libraries/IfsoTypes.sol";
import {IIfsoEscrow} from "./interfaces/IIfsoEscrow.sol";
import {IIfsoConditionEvaluator} from "./interfaces/IIfsoConditionEvaluator.sol";
import {IUSDG} from "./interfaces/IUSDG.sol";
import {IERC20} from "./interfaces/IERC20.sol";
import {EIP712} from "./utils/EIP712.sol";
import {ReentrancyGuard} from "./utils/ReentrancyGuard.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";
import {ECDSA} from "./libraries/ECDSA.sol";
import {SignatureChecker} from "./libraries/SignatureChecker.sol";

/// @title  IfsoEscrow — conditional money on Robinhood Chain
/// @notice Non-custodial USDG escrow that unlocks only when a condition is met:
///         TIME (a timestamp), PRICE (Chainlink / Pyth level, at-deadline or touch), APPROVE (both parties tap
///         OK, or a named referee), OUTCOME (bonded optimistic resolver).
///
///         Invariants (no admin key can break them):
///         - Funds leave only to the bound recipient (condition met) or to the sender's preset refund
///           destinations (condition false / void / expiry / cancel). No other path exists.
///         - Every escrow has an expiry. After it, ANYONE can refund. Refund, claim and settle are never
///           gated by the creation pause. The sender presets a primary AND an alternate refund address, and
///           the refund caller may pick either, so a refund never depends on one address being able to
///           transact or receive (sequencer screening / token blocklists).
///         - Claim links: the URL fragment holds a secret; its derived key's address is `linkKey`. A claimer
///           signs EIP-712 Claim(id, recipient, conditionHash) with that key, so a copied claim tx cannot be
///           redirected. The first valid claim binds the recipient (pre-claim before the condition resolves).
///         - Each party may always concede against itself: the sender's OK releases (except PARTIES mode,
///           which needs both OKs), the recipient's decline returns funds to the sender.
///         - Two-sided challenges are invite-only (named address or private link), take a flat creation fee
///           only, never a percentage of stakes or of what anyone receives.
contract IfsoEscrow is IIfsoEscrow, EIP712, ReentrancyGuard, Owned2Step {
    using SafeTransferLib for address;

    // ------------------------------------------------------------------ constants
    uint96 public constant MAX_CREATION_FEE = 5e6; // 5 USDG hard cap
    uint96 public constant MAX_RESOLVER_FEE = 5e6; // 5 USDG hard cap
    uint96 public constant MIN_AMOUNT = 1e6; //       1 USDG (anti-dust / anti-spam)
    uint64 public constant MIN_EXPIRY_DELAY = 1 hours;
    uint64 public constant MAX_DURATION = 400 days;
    /// @notice Hard ceiling of `setMaxAmount` (the full uint96 range: the setter can never overflow an amount).
    uint96 public constant MAX_AMOUNT_CAP = type(uint96).max;

    uint8 internal constant F_TWO_SIDED = 1;
    uint8 internal constant F_ACCEPTED = 2;
    uint8 internal constant F_CANCELLABLE = 4;
    uint8 internal constant F_SENDER_OK = 8;
    uint8 internal constant F_RECIPIENT_OK = 16;
    uint8 internal constant F_SENDER_OWED = 32; //  VOIDED: sender side not paid yet (its transfer failed)
    uint8 internal constant F_COUNTER_OWED = 64; // VOIDED: acceptor side not paid yet (its transfer failed)

    // Return reasons (event field)
    uint8 internal constant R_CONDITION_FALSE = 1;
    uint8 internal constant R_VOID = 2;
    uint8 internal constant R_EXPIRED = 3;
    uint8 internal constant R_NOT_ACCEPTED = 4;
    uint8 internal constant R_DECLINED = 5;
    uint8 internal constant R_REFEREE = 6;

    // Decision actions (signed)
    uint8 public constant ACTION_OK = 1;
    uint8 public constant ACTION_DECLINE = 2;
    uint8 public constant ACTION_REFEREE_RELEASE = 3;
    uint8 public constant ACTION_REFEREE_RETURN = 4;

    bytes32 public constant CLAIM_TYPEHASH = keccak256("Claim(uint256 id,address recipient,bytes32 conditionHash)");
    bytes32 public constant ACCEPT_TYPEHASH = keccak256("Accept(uint256 id,address acceptor,bytes32 conditionHash)");
    bytes32 public constant DECISION_TYPEHASH =
        keccak256("Decision(uint256 id,uint8 action,uint256 nonce,uint256 deadline)");
    bytes32 public constant REFUND_REDIRECT_TYPEHASH =
        keccak256("RefundRedirect(uint256 id,address refundTo,address altRefundTo,uint256 nonce,uint256 deadline)");
    /// @dev EIP-3009 nonces are bound to the exact params, so a relayed authorization cannot be re-pointed.
    bytes32 public constant CREATE_AUTH_TAG = keccak256("IFSO_CREATE_V1");
    bytes32 public constant ACCEPT_AUTH_TAG = keccak256("IFSO_ACCEPT_V1");

    // ------------------------------------------------------------------ immutables
    IUSDG public immutable usdg;
    IIfsoConditionEvaluator public immutable evaluator;
    address public immutable feeRouter;

    // ------------------------------------------------------------------ state
    uint96 public creationFee;
    uint96 public resolverFee;
    bool public creationPaused;
    /// @notice Per-escrow launch cap on each side's amount (USDG, 6 decimals). 0 = no cap.
    ///         Gates NEW creates and challenge accepts only; existing escrows always exit.
    uint96 public maxAmount;

    mapping(uint256 => Escrow) internal _escrows;
    mapping(uint256 => Condition) internal _conditions;
    mapping(address => uint256) public nonces;

    constructor(
        address owner_,
        IUSDG usdg_,
        IIfsoConditionEvaluator evaluator_,
        address feeRouter_,
        uint96 creationFee_,
        uint96 resolverFee_
    ) EIP712("IFSO", "1") Owned2Step(owner_) {
        if (address(usdg_) == address(0) || address(evaluator_) == address(0) || feeRouter_ == address(0)) {
            revert ZeroAddress();
        }
        if (creationFee_ > MAX_CREATION_FEE || resolverFee_ > MAX_RESOLVER_FEE) revert FeeTooHigh();
        usdg = usdg_;
        evaluator = evaluator_;
        feeRouter = feeRouter_;
        creationFee = creationFee_;
        resolverFee = resolverFee_;
    }

    // ================================================================== admin (never touches escrows)
    /// @notice Sets the flat creation and resolver fees for NEW escrows (each capped at 5 USDG).
    /// @param creationFee_ Flat creation fee in USDG base units (<= 5 USDG).
    /// @param resolverFee_ Extra flat fee for OUTCOME escrows in USDG base units (<= 5 USDG).
    function setFees(uint96 creationFee_, uint96 resolverFee_) external onlyOwner {
        if (creationFee_ > MAX_CREATION_FEE || resolverFee_ > MAX_RESOLVER_FEE) revert FeeTooHigh();
        creationFee = creationFee_;
        resolverFee = resolverFee_;
        emit FeesUpdated(creationFee_, resolverFee_);
    }

    /// @notice Pauses NEW escrows and challenge acceptances only. Claims, settles, decisions, cancels and
    ///         refunds keep working while paused.
    /// @param paused true pauses new escrows and accepts; exits are never paused.
    function setCreationPaused(bool paused) external onlyOwner {
        creationPaused = paused;
        emit CreationPaused(paused);
    }

    /// @notice Sets the per-escrow cap on each side's amount. Applies to NEW creates and challenge accepts only:
    ///         lowering it never blocks claim, settle, decisions, cancel or refund of existing escrows.
    /// @param maxAmount_ New cap in USDG base units (6 decimals); 0 removes the cap, otherwise at least MIN_AMOUNT.
    function setMaxAmount(uint96 maxAmount_) external onlyOwner {
        if (maxAmount_ != 0 && maxAmount_ < MIN_AMOUNT) revert InvalidParams();
        maxAmount = maxAmount_;
        emit MaxAmountUpdated(maxAmount_);
    }

    // ================================================================== create
    /// @notice Create from msg.sender's USDG allowance (EOA approve, or a smart-account batch approve+create).
    /// @param p Escrow parameters (amounts, recipient or link key, refund addresses, expiry, condition).
    function create(CreateParams calldata p) external nonReentrant returns (uint256 id) {
        uint96 fee;
        (id, fee) = _create(p, msg.sender);
        _pull(msg.sender, uint256(p.amount) + fee, fee);
    }

    /// @notice Create using an EIP-2612 permit (one transaction for an EOA). A front-run permit is tolerated.
    /// @param p Escrow parameters (amounts, recipient or link key, refund addresses, expiry, condition).
    /// @param permitDeadline EIP-2612 permit deadline.
    /// @param v Permit signature v.
    /// @param r Permit signature r.
    /// @param s Permit signature s.
    function createWithPermit(CreateParams calldata p, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256 id)
    {
        uint96 fee;
        (id, fee) = _create(p, msg.sender);
        uint256 total = uint256(p.amount) + fee;
        try usdg.permit(msg.sender, address(this), total, permitDeadline, v, r, s) {} catch {}
        _pull(msg.sender, total, fee);
    }

    /// @notice Gasless for the sender: anyone relays a USDG EIP-3009 receiveWithAuthorization signed by `from`
    ///         (65-byte r||s||v in `authSig`). Its nonce MUST equal createAuthNonce(from, p), so the
    ///         authorization only works with these exact params (a copied tx cannot re-point the money).
    /// @param p Escrow parameters (amounts, recipient or link key, refund addresses, expiry, condition).
    /// @param from USDG holder that signed the EIP-3009 authorization (becomes the sender).
    /// @param validAfter EIP-3009 validAfter (unix seconds).
    /// @param validBefore EIP-3009 validBefore (unix seconds).
    /// @param authSig 65-byte r||s||v EIP-3009 receiveWithAuthorization signature.
    function createWithAuthorization(
        CreateParams calldata p,
        address from,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata authSig
    ) external nonReentrant returns (uint256 id) {
        uint96 fee;
        (id, fee) = _create(p, from);
        _receiveWithAuth(from, uint256(p.amount) + fee, validAfter, validBefore, createAuthNonce(from, p), authSig);
        if (fee != 0) address(usdg).safeTransfer(feeRouter, fee);
    }

    /// @notice Bulk create (premium payroll-style runs). One allowance pull for the whole batch.
    /// @param ps One CreateParams per escrow in the batch.
    function createBatch(CreateParams[] calldata ps) external nonReentrant returns (uint256[] memory ids) {
        ids = new uint256[](ps.length);
        uint256 total;
        uint256 fees;
        for (uint256 i; i < ps.length; ++i) {
            (uint256 id, uint96 fee) = _create(ps[i], msg.sender);
            ids[i] = id;
            total += uint256(ps[i].amount) + fee;
            fees += fee;
        }
        _pull(msg.sender, total, fees);
    }

    /// @notice EIP-3009 nonce that binds a gasless create to these exact params.
    /// @param from USDG holder that signed the EIP-3009 authorization (becomes the sender).
    /// @param p Escrow parameters (amounts, recipient or link key, refund addresses, expiry, condition).
    function createAuthNonce(address from, CreateParams calldata p) public pure returns (bytes32) {
        return keccak256(abi.encode(CREATE_AUTH_TAG, from, keccak256(abi.encode(p))));
    }

    function _pull(address from, uint256 total, uint256 fee) private {
        address(usdg).safeTransferFrom(from, address(this), total);
        if (fee != 0) address(usdg).safeTransfer(feeRouter, fee);
    }

    function _create(CreateParams calldata p, address sender) private returns (uint256 id, uint96 fee) {
        if (creationPaused) revert CreationIsPaused();
        uint64 nowTs = uint64(block.timestamp);
        Condition calldata c = p.condition;

        if (p.amount < MIN_AMOUNT) revert InvalidParams();
        _checkCap(p.amount, p.counterAmount);
        if ((p.recipient == address(0)) == (p.linkKey == address(0))) revert InvalidParams(); // exactly one
        if (p.recipient == address(this)) revert BadRecipient();
        if (p.expiry < nowTs + MIN_EXPIRY_DELAY || p.expiry > nowTs + MAX_DURATION) revert InvalidParams();

        if (p.twoSided) {
            // invite-only challenge: never TIME, never honor-system PARTIES mode, never cancellable after accept
            if (c.kind == Kind.TIME || (c.kind == Kind.APPROVE && c.mode == APPROVE_PARTIES)) revert InvalidParams();
            if (p.counterAmount < MIN_AMOUNT || p.cancellable) revert InvalidParams();
            if (p.acceptBy <= nowTs || p.acceptBy >= p.expiry) revert InvalidParams();
        } else {
            if (p.counterAmount != 0 || p.acceptBy != 0) revert InvalidParams();
        }
        if (c.kind == Kind.APPROVE && c.mode == APPROVE_REFEREE) {
            if (c.target == sender || c.target == p.recipient) revert InvalidParams();
        }
        evaluator.validate(c, p.expiry, p.twoSided ? p.acceptBy : 0);

        id = idFor(sender, p.salt);
        Escrow storage e = _escrows[id];
        if (e.status != Status.NONE) revert AlreadyExists();

        e.sender = sender;
        e.amount = p.amount;
        e.recipient = p.recipient;
        e.counterAmount = p.counterAmount;
        e.linkKey = p.linkKey;
        e.activeFrom = nowTs;
        e.status = Status.OPEN;
        e.flags = (p.twoSided ? F_TWO_SIDED : 0) | (p.cancellable ? F_CANCELLABLE : 0);
        e.refundTo = p.refundTo == address(0) ? sender : p.refundTo;
        e.altRefundTo = p.altRefundTo;
        e.expiry = p.expiry;
        e.acceptBy = p.acceptBy;
        bytes32 ch = keccak256(abi.encode(c));
        e.conditionHash = ch;
        _conditions[id] = c;

        fee = feeFor(c.kind);
        _emitCreated(id, e, c.kind, fee);
    }

    function _checkCap(uint96 amount, uint96 counterAmount) private view {
        uint96 cap = maxAmount;
        if (cap != 0 && (amount > cap || counterAmount > cap)) revert AmountAboveCap();
    }

    function _emitCreated(uint256 id, Escrow storage e, Kind kind, uint96 fee) private {
        emit Created(
            id,
            e.sender,
            e.recipient,
            e.linkKey,
            e.amount,
            e.counterAmount,
            kind,
            e.conditionHash,
            e.expiry,
            e.flags & F_TWO_SIDED != 0,
            fee
        );
    }

    // ================================================================== two-sided accept
    /// @notice Invitee accepts a challenge, paying their stake from allowance. Link challenges need the link
    ///         key's Accept signature over the acceptor. Named challenges need msg.sender == recipient.
    /// @param id Escrow id (see idFor).
    /// @param linkSig Signature by the claim-link key over the EIP-712 message (empty for named challenges).
    /// @param counterRefundTo Where the acceptor's own amount goes back on VOID or expiry (0 = the acceptor).
    function accept(uint256 id, bytes calldata linkSig, address counterRefundTo) external nonReentrant {
        Escrow storage e = _accept(id, msg.sender, linkSig, counterRefundTo);
        address(usdg).safeTransferFrom(msg.sender, address(this), e.counterAmount);
    }

    /// @notice Gasless accept via EIP-3009; nonce = acceptAuthNonce(id, acceptor, counterRefundTo).
    /// @param id Escrow id (see idFor).
    /// @param acceptor Address that joins the challenge and pays the counter amount.
    /// @param linkSig Signature by the claim-link key over the EIP-712 message (empty for named challenges).
    /// @param counterRefundTo Where the acceptor's own amount goes back on VOID or expiry (0 = the acceptor).
    /// @param validAfter EIP-3009 validAfter (unix seconds).
    /// @param validBefore EIP-3009 validBefore (unix seconds).
    /// @param authSig 65-byte r||s||v EIP-3009 receiveWithAuthorization signature.
    function acceptWithAuthorization(
        uint256 id,
        address acceptor,
        bytes calldata linkSig,
        address counterRefundTo,
        uint256 validAfter,
        uint256 validBefore,
        bytes calldata authSig
    ) external nonReentrant {
        Escrow storage e = _accept(id, acceptor, linkSig, counterRefundTo);
        bytes32 nonce = acceptAuthNonce(id, acceptor, counterRefundTo);
        _receiveWithAuth(acceptor, e.counterAmount, validAfter, validBefore, nonce, authSig);
    }

    /// @dev Pulls `value` from `from` via USDG EIP-3009 receiveWithAuthorization (caller must be payee).
    function _receiveWithAuth(
        address from,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata authSig
    ) private {
        (uint8 v, bytes32 r, bytes32 s) = ECDSA.split(authSig);
        usdg.receiveWithAuthorization(from, address(this), value, validAfter, validBefore, nonce, v, r, s);
    }

    /// @notice EIP-3009 nonce that binds a gasless accept to this escrow, acceptor and refund address.
    /// @param id Escrow id (see idFor).
    /// @param acceptor Address that joins the challenge and pays the counter amount.
    /// @param counterRefundTo Where the acceptor's own amount goes back on VOID or expiry (0 = the acceptor).
    function acceptAuthNonce(uint256 id, address acceptor, address counterRefundTo) public pure returns (bytes32) {
        return keccak256(abi.encode(ACCEPT_AUTH_TAG, id, acceptor, counterRefundTo));
    }

    function _accept(uint256 id, address acceptor, bytes calldata linkSig, address counterRefundTo)
        private
        returns (Escrow storage e)
    {
        if (creationPaused) revert CreationIsPaused();
        e = _escrows[id];
        if (e.flags & F_TWO_SIDED == 0) revert NotTwoSided();
        if (e.status != Status.OPEN) revert NotOpen();
        if (e.flags & F_ACCEPTED != 0) revert AlreadyAccepted();
        _checkCap(e.amount, e.counterAmount); // accepting is a new entry: the cap in force now applies
        if (block.timestamp > e.acceptBy) revert AcceptWindowClosed();
        if (acceptor == address(0) || acceptor == e.sender || acceptor == address(this)) revert BadRecipient();

        if (e.linkKey == address(0)) {
            if (acceptor != e.recipient) revert NotAuthorized();
        } else {
            bytes32 digest = _hashTypedData(keccak256(abi.encode(ACCEPT_TYPEHASH, id, acceptor, e.conditionHash)));
            if (ECDSA.recover(digest, linkSig) != e.linkKey) revert BadSignature();
            e.recipient = acceptor;
        }
        Condition storage c = _conditions[id];
        if (c.kind == Kind.APPROVE && c.target == acceptor) revert BadRecipient(); // referee can't be a party
        e.flags |= F_ACCEPTED;
        e.activeFrom = uint64(block.timestamp); // TOUCH windows start only once both sides are in
        e.counterRefundTo = counterRefundTo == address(0) ? acceptor : counterRefundTo;
        emit Accepted(id, acceptor, e.counterRefundTo);
    }

    // ================================================================== claim links
    /// @notice Binds the recipient of a link payment (anyone may submit; the link signature fixes the
    ///         recipient). If the condition is already met, pays immediately.
    /// @param id Escrow id (see idFor).
    /// @param recipient Address the payment is bound to.
    /// @param linkSig Signature by the claim-link key over the EIP-712 message (empty for named challenges).
    function claim(uint256 id, address recipient, bytes calldata linkSig) external nonReentrant {
        Escrow storage e = _escrows[id];
        if (e.linkKey == address(0)) revert NotALink();
        if (e.flags & F_TWO_SIDED != 0) revert NotAuthorized(); // challenges use accept()
        if (e.status != Status.OPEN && e.status != Status.MET) revert NotOpen();
        if (e.recipient != address(0)) revert AlreadyClaimed();
        if (block.timestamp >= e.expiry) revert Expired();
        if (recipient == address(0) || recipient == address(this)) revert BadRecipient();
        Condition storage c = _conditions[id];
        if (c.kind == Kind.APPROVE && c.target == recipient) revert BadRecipient();

        bytes32 digest = _hashTypedData(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient, e.conditionHash)));
        if (ECDSA.recover(digest, linkSig) != e.linkKey) revert BadSignature();

        e.recipient = recipient;
        emit Claimed(id, recipient);
        if (e.status == Status.MET) _release(id, e);
    }

    // ================================================================== settle (TIME / PRICE / OUTCOME)
    /// @notice Anyone (keeper, recipient, sender) settles once the condition is decidable.
    /// @param proof     see IIfsoConditionEvaluator.evaluate
    /// @param senderAlt pay the sender side to its alternate refund address (screened primary)
    /// @param id Escrow id (see idFor).
    function settle(uint256 id, bytes calldata proof, bool senderAlt)
        external
        payable
        nonReentrant
        returns (Verdict v)
    {
        Escrow storage e = _escrows[id];
        if (e.status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= e.expiry) revert Expired();
        if (e.flags & F_TWO_SIDED != 0 && e.flags & F_ACCEPTED == 0) revert NotAccepted();
        Condition memory c = _conditions[id];
        if (c.kind == Kind.APPROVE) revert UseDecision();
        v = evaluator.evaluate{value: msg.value}(c, e.activeFrom, proof, msg.sender);
        if (v == Verdict.PENDING) revert ConditionPending();
        _apply(id, e, v, senderAlt, false, R_CONDITION_FALSE);
    }

    // ================================================================== decisions (APPROVE + concessions)
    /// @notice "Tap OK". Sender or bound recipient.
    ///         PARTIES mode: releases when both have tapped OK. Every other mode: the sender's OK alone
    ///         releases (a concession against itself); the recipient's OK is recorded only.
    /// @param id Escrow id (see idFor).
    function approve(uint256 id) external nonReentrant {
        _ok(id, msg.sender);
    }

    /// @notice Recipient gives the money back to the sender (always allowed: a concession against itself).
    /// @param id Escrow id (see idFor).
    function decline(uint256 id) external nonReentrant {
        _decline(id, msg.sender);
    }

    /// @notice Named referee decides. Only two outcomes exist: release to recipient, or return to sender.
    /// @param id Escrow id (see idFor).
    /// @param toRecipient true releases to the recipient, false returns to the sender.
    function refereeDecide(uint256 id, bool toRecipient) external nonReentrant {
        _referee(id, msg.sender, toRecipient);
    }

    /// @notice Relayed decision signed (EIP-712 Decision) by the sender, recipient or referee.
    ///         EOA or EIP-1271 smart account (e.g. passkey Kernel) signatures.
    /// @param id Escrow id (see idFor).
    /// @param signer Sender, recipient or referee that signed the decision (EOA or EIP-1271 account).
    /// @param action 1 OK, 2 decline, 3 referee release, 4 referee return.
    /// @param deadline Signature deadline (unix seconds).
    /// @param sig EIP-712 signature (EOA) or EIP-1271 signature bytes (smart account).
    function decideBySig(uint256 id, address signer, uint8 action, uint256 deadline, bytes calldata sig)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        uint256 nonce = nonces[signer]++;
        bytes32 digest = _hashTypedData(keccak256(abi.encode(DECISION_TYPEHASH, id, action, nonce, deadline)));
        if (!SignatureChecker.isValid(signer, digest, sig)) revert BadSignature();
        if (action == ACTION_OK) _ok(id, signer);
        else if (action == ACTION_DECLINE) _decline(id, signer);
        else if (action == ACTION_REFEREE_RELEASE) _referee(id, signer, true);
        else if (action == ACTION_REFEREE_RETURN) _referee(id, signer, false);
        else revert InvalidParams();
    }

    function _decisionGuard(uint256 id) private view returns (Escrow storage e) {
        e = _escrows[id];
        if (e.status != Status.OPEN) revert NotOpen();
        if (block.timestamp >= e.expiry) revert Expired();
        if (e.flags & F_TWO_SIDED != 0 && e.flags & F_ACCEPTED == 0) revert NotAccepted();
    }

    function _ok(uint256 id, address who) private {
        Escrow storage e = _decisionGuard(id);
        uint8 bit;
        if (who == e.sender) bit = F_SENDER_OK;
        else if (who != address(0) && who == e.recipient) bit = F_RECIPIENT_OK;
        else revert NotAuthorized();
        if (e.flags & bit != 0) revert NoChange(); // R1-M5: a repeated OK changes nothing (relayer-paid no-op)
        e.flags |= bit;
        emit Approved(id, who);

        Condition storage c = _conditions[id];
        bool release = (c.kind == Kind.APPROVE && c.mode == APPROVE_PARTIES)
            ? (e.flags & F_SENDER_OK != 0 && e.flags & F_RECIPIENT_OK != 0)
            : (e.flags & F_SENDER_OK != 0);
        if (release) _apply(id, e, Verdict.TRUE, false, false, 0);
    }

    function _decline(uint256 id, address who) private {
        Escrow storage e = _decisionGuard(id);
        if (who == address(0) || who != e.recipient) revert NotAuthorized();
        emit Declined(id, who);
        _apply(id, e, Verdict.FALSE, false, false, R_DECLINED);
    }

    function _referee(uint256 id, address who, bool toRecipient) private {
        Escrow storage e = _decisionGuard(id);
        Condition storage c = _conditions[id];
        if (c.kind != Kind.APPROVE || c.mode != APPROVE_REFEREE || who != c.target) revert NotAuthorized();
        emit RefereeDecided(id, who, toRecipient);
        _apply(id, e, toRecipient ? Verdict.TRUE : Verdict.FALSE, false, false, R_REFEREE);
    }

    // ================================================================== cancel / refund
    /// @notice Sender cancels a cancellable one-sided payment, or a challenge nobody accepted yet.
    /// @param id Escrow id (see idFor).
    function cancel(uint256 id) external nonReentrant {
        Escrow storage e = _escrows[id];
        if (msg.sender != e.sender) revert NotAuthorized();
        if (e.status != Status.OPEN) revert NotOpen();
        bool twoSided = e.flags & F_TWO_SIDED != 0;
        bool ok = twoSided ? (e.flags & F_ACCEPTED == 0) : (e.flags & F_CANCELLABLE != 0);
        if (!ok) revert NotCancellable();
        e.status = Status.CANCELLED;
        uint256 amt = e.amount;
        address to = e.refundTo;
        address(usdg).safeTransfer(to, amt);
        emit Cancelled(id, to, amt);
    }

    /// @notice ANYONE refunds after expiry (or after an unaccepted challenge's accept window).
    ///         Never paused. The caller may route each side to its preset alternate address.
    /// @param id Escrow id (see idFor).
    /// @param senderAlt Send the sender side to its alternate refund address instead of the primary.
    /// @param counterAlt Send the acceptor side to the acceptor address instead of its refund address.
    function refund(uint256 id, bool senderAlt, bool counterAlt) external nonReentrant {
        Escrow storage e = _escrows[id];
        if (e.status != Status.OPEN && e.status != Status.MET) revert NotOpen();
        bool twoSided = e.flags & F_TWO_SIDED != 0;
        bool accepted = e.flags & F_ACCEPTED != 0;
        bool unaccepted = twoSided && !accepted && block.timestamp > e.acceptBy;
        if (block.timestamp < e.expiry && !unaccepted) revert NotExpired();
        if (twoSided && accepted) {
            _apply(id, e, Verdict.VOID, senderAlt, counterAlt, R_EXPIRED);
        } else {
            _returnAll(id, e, senderAlt, unaccepted ? R_NOT_ACCEPTED : R_EXPIRED);
        }
    }

    /// @notice Sender changes its refund destinations (e.g. its wallet got screened).
    /// @param id Escrow id (see idFor).
    /// @param refundTo Primary refund destination (never 0).
    /// @param altRefundTo Alternate refund destination (0 = none).
    function setRefundAddresses(uint256 id, address refundTo, address altRefundTo) external nonReentrant {
        Escrow storage e = _escrows[id];
        if (msg.sender != e.sender) revert NotAuthorized();
        _setRefund(id, e, refundTo, altRefundTo);
    }

    /// @notice Relayed version: the sender signs, anyone submits. Lets a sender that cannot transact on RHC
    ///         (screened at the sequencer) still steer its refund.
    /// @param id Escrow id (see idFor).
    /// @param refundTo Primary refund destination (never 0).
    /// @param altRefundTo Alternate refund destination (0 = none).
    /// @param deadline Signature deadline (unix seconds).
    /// @param sig EIP-712 signature (EOA) or EIP-1271 signature bytes (smart account).
    function setRefundAddressesBySig(
        uint256 id,
        address refundTo,
        address altRefundTo,
        uint256 deadline,
        bytes calldata sig
    ) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        Escrow storage e = _escrows[id];
        address signer = e.sender;
        uint256 nonce = nonces[signer]++;
        bytes32 digest =
            _hashTypedData(keccak256(abi.encode(REFUND_REDIRECT_TYPEHASH, id, refundTo, altRefundTo, nonce, deadline)));
        if (!SignatureChecker.isValid(signer, digest, sig)) revert BadSignature();
        _setRefund(id, e, refundTo, altRefundTo);
    }

    function _setRefund(uint256 id, Escrow storage e, address refundTo, address altRefundTo) private {
        // also while a VOIDED sender side is still owed (its destination could not receive, R1-M4)
        if (e.status != Status.OPEN && e.status != Status.MET && _notOwed(e, F_SENDER_OWED)) revert NotOpen();
        if (refundTo == address(0) || refundTo == address(this) || altRefundTo == address(this)) {
            revert InvalidParams();
        }
        if (refundTo == e.refundTo && altRefundTo == e.altRefundTo) revert NoChange(); // R1-M5
        e.refundTo = refundTo;
        e.altRefundTo = altRefundTo;
        emit RefundAddressesChanged(id, refundTo, altRefundTo);
    }

    /// @notice Challenge acceptor changes where its own stake is returned on VOID / expiry.
    /// @param id Escrow id (see idFor).
    /// @param counterRefundTo Where the acceptor's own amount goes back on VOID or expiry (0 = the acceptor).
    function setCounterRefundTo(uint256 id, address counterRefundTo) external nonReentrant {
        Escrow storage e = _escrows[id];
        if (msg.sender != e.recipient || e.flags & F_ACCEPTED == 0) revert NotAuthorized();
        if (e.status != Status.OPEN && _notOwed(e, F_COUNTER_OWED)) revert NotOpen();
        if (counterRefundTo == address(0) || counterRefundTo == address(this)) revert InvalidParams();
        e.counterRefundTo = counterRefundTo;
        emit CounterRefundChanged(id, counterRefundTo);
    }

    // ================================================================== payouts
    function _apply(uint256 id, Escrow storage e, Verdict v, bool senderAlt, bool counterAlt, uint8 reason) private {
        if (v == Verdict.TRUE) {
            if (e.recipient == address(0)) {
                e.status = Status.MET; // link not claimed yet; claim() pays
                emit Met(id);
            } else {
                _release(id, e);
            }
        } else if (v == Verdict.FALSE) {
            _returnAll(id, e, senderAlt, reason);
        } else if (v == Verdict.VOID) {
            if (e.flags & F_ACCEPTED != 0) {
                // R1-M4: each side is paid on its own. A side whose destination cannot receive (e.g. frozen by the
                // USDG issuer) is left owed for claimVoid (reported as address 0) and never blocks the other side.
                e.status = Status.VOIDED;
                address sTo = _senderDest(e, senderAlt);
                address cTo = _counterDest(e, counterAlt);
                uint256 sAmt = e.amount;
                uint256 cAmt = e.counterAmount;
                if (!_tryPay(sTo, sAmt)) (e.flags, sTo) = (e.flags | F_SENDER_OWED, address(0));
                if (!_tryPay(cTo, cAmt)) (e.flags, cTo) = (e.flags | F_COUNTER_OWED, address(0));
                emit Voided(id, sTo, sAmt, cTo, cAmt);
            } else {
                _returnAll(id, e, senderAlt, reason == R_EXPIRED ? R_EXPIRED : R_VOID);
            }
        } else {
            revert ConditionPending();
        }
    }

    function _release(uint256 id, Escrow storage e) private {
        uint256 pot = uint256(e.amount) + (e.flags & F_ACCEPTED != 0 ? uint256(e.counterAmount) : 0);
        e.status = Status.RELEASED;
        address to = e.recipient;
        address(usdg).safeTransfer(to, pot);
        emit Released(id, to, pot);
    }

    /// @dev Sender side receives everything held (its stake, plus the accepted counter-stake if any).
    function _returnAll(uint256 id, Escrow storage e, bool senderAlt, uint8 reason) private {
        uint256 pot = uint256(e.amount) + (e.flags & F_ACCEPTED != 0 ? uint256(e.counterAmount) : 0);
        e.status = Status.RETURNED;
        address to = _senderDest(e, senderAlt);
        address(usdg).safeTransfer(to, pot);
        emit Returned(id, to, pot, reason);
    }

    /// @notice Pays a VOIDED challenge side that could not be paid when the escrow was voided (its destination
    ///         could not receive). ANYONE may call; the money only goes to that side's own preset destinations.
    ///         The owed party may first point them elsewhere (setRefundAddresses / setCounterRefundTo).
    /// @param id Escrow id (see idFor).
    /// @param counterSide true pays the acceptor side, false the sender side.
    /// @param alt Sender side: its alternate refund address. Acceptor side: the acceptor address itself.
    function claimVoid(uint256 id, bool counterSide, bool alt) external nonReentrant {
        Escrow storage e = _escrows[id];
        uint8 bit = counterSide ? F_COUNTER_OWED : F_SENDER_OWED;
        if (e.status != Status.VOIDED || e.flags & bit == 0) revert NotOpen();
        e.flags &= ~bit;
        address to = counterSide ? _counterDest(e, alt) : _senderDest(e, alt);
        uint256 amt = counterSide ? e.counterAmount : e.amount;
        address(usdg).safeTransfer(to, amt);
        emit VoidClaimed(id, to, amt);
    }

    /// @dev USDG transfer that reports failure instead of reverting (USDG is a known token: true or revert).
    ///      A transfer that ran out of gas reverts the whole call instead, so a caller cannot starve the transfer
    ///      (63/64 rule) to push a payable side into the owed state. USDG is a proxy: an out-of-gas in its inner
    ///      frame hands back about 2/64 of `g`, so the bound is g/16, not g/63 (R2-I1).
    function _tryPay(address to, uint256 amt) private returns (bool) {
        uint256 g = gasleft();
        (bool ok, bytes memory r) = address(usdg).call(abi.encodeCall(IERC20.transfer, (to, amt)));
        if (!ok && gasleft() <= g / 16) revert();
        return ok && (r.length == 0 || (r.length == 32 && uint256(bytes32(r)) == 1));
    }

    function _notOwed(Escrow storage e, uint8 bit) private view returns (bool) {
        return e.status != Status.VOIDED || e.flags & bit == 0;
    }

    function _counterDest(Escrow storage e, bool alt) private view returns (address) {
        return alt ? e.recipient : e.counterRefundTo;
    }

    function _senderDest(Escrow storage e, bool alt) private view returns (address) {
        if (!alt) return e.refundTo;
        if (e.altRefundTo == address(0)) revert NoAlternate();
        return e.altRefundTo;
    }

    // ================================================================== views
    /// @notice Full escrow record.
    /// @param id Escrow id (see idFor).
    function getEscrow(uint256 id) external view returns (Escrow memory) {
        return _escrows[id];
    }

    /// @notice Condition the escrow was created with.
    /// @param id Escrow id (see idFor).
    function getCondition(uint256 id) external view returns (Condition memory) {
        return _conditions[id];
    }

    /// @notice Escrow id for a sender and salt: keccak256(abi.encode(sender, salt)).
    /// @param sender Escrow creator.
    /// @param salt Client-chosen salt.
    function idFor(address sender, bytes32 salt) public pure returns (uint256) {
        return uint256(keccak256(abi.encode(sender, salt)));
    }

    /// @notice Flat fee charged at creation for a condition kind (OUTCOME adds the resolver fee).
    /// @param kind Condition kind.
    function feeFor(Kind kind) public view returns (uint96) {
        return kind == Kind.OUTCOME ? creationFee + resolverFee : creationFee;
    }

    /// @notice EIP-712 digest a claim-link key signs to bind a recipient.
    /// @param id Escrow id (see idFor).
    /// @param recipient Address the payment is bound to.
    /// @param conditionHash keccak256(abi.encode(condition)).
    function hashClaim(uint256 id, address recipient, bytes32 conditionHash) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(CLAIM_TYPEHASH, id, recipient, conditionHash)));
    }

    /// @notice EIP-712 digest a claim-link key signs to let an acceptor join a link challenge.
    /// @param id Escrow id (see idFor).
    /// @param acceptor Address that joins the challenge and pays the counter amount.
    /// @param conditionHash keccak256(abi.encode(condition)).
    function hashAccept(uint256 id, address acceptor, bytes32 conditionHash) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(ACCEPT_TYPEHASH, id, acceptor, conditionHash)));
    }

    /// @notice EIP-712 digest for a relayed decision (decideBySig).
    /// @param id Escrow id (see idFor).
    /// @param action 1 OK, 2 decline, 3 referee release, 4 referee return.
    /// @param nonce Signer nonce (see nonces).
    /// @param deadline Signature deadline (unix seconds).
    function hashDecision(uint256 id, uint8 action, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedData(keccak256(abi.encode(DECISION_TYPEHASH, id, action, nonce, deadline)));
    }

    /// @notice EIP-712 digest for a relayed refund-address change (setRefundAddressesBySig).
    /// @param id Escrow id (see idFor).
    /// @param refundTo Primary refund destination (never 0).
    /// @param altRefundTo Alternate refund destination (0 = none).
    /// @param nonce Signer nonce (see nonces).
    /// @param deadline Signature deadline (unix seconds).
    function hashRefundRedirect(uint256 id, address refundTo, address altRefundTo, uint256 nonce, uint256 deadline)
        external
        view
        returns (bytes32)
    {
        return
            _hashTypedData(keccak256(abi.encode(REFUND_REDIRECT_TYPEHASH, id, refundTo, altRefundTo, nonce, deadline)));
    }

    /// @notice Condition hash that link signatures commit to.
    /// @param c Condition to hash.
    function conditionHashOf(Condition calldata c) external pure returns (bytes32) {
        return keccak256(abi.encode(c));
    }
}

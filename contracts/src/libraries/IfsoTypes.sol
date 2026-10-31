// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;
// Origin: Own definitions for this protocol; no upstream.

/// @notice Condition kinds supported at launch. Every kind is resolvable with infrastructure live on
///         Robinhood Chain today (block time, Chainlink/Pyth feeds, signatures, the IFSO outcome resolver).
enum Kind {
    NONE,
    TIME, //     unlocks at `deadline`
    PRICE, //    Chainlink (or Pyth) price vs `threshold`, AT_DEADLINE or TOUCH semantics
    APPROVE, //  both parties tap OK, or a named referee decides
    OUTCOME //   result posted to IfsoOutcomeResolver (bonded, disputable)
}

/// @notice Result of evaluating a condition.
enum Verdict {
    PENDING, // not decidable yet (or the proof supplied does not decide it)
    TRUE, //    condition met -> recipient side
    FALSE, //   condition definitively not met -> sender side
    VOID //     condition cannot be fairly decided (postponed match, corporate action, no print) -> each side refunded
}

/// @notice Lifecycle of an escrow.
enum Status {
    NONE,
    OPEN, //      funded, condition pending
    MET, //       condition true, waiting for a link claim (recipient not bound yet)
    RELEASED, //  recipient paid
    RETURNED, //  sender side paid (refund, condition false, expiry, or sender won a challenge)
    VOIDED, //    two-sided: each side got its own stake back
    CANCELLED //  sender cancelled a cancellable payment / an unaccepted challenge
}

/// @dev Price condition modes.
uint8 constant PRICE_AT_DEADLINE = 0; // price in force at the deadline (with off-hours hold)
uint8 constant PRICE_TOUCH = 1; //       any feed round inside [start, deadline] crosses the threshold

/// @dev Comparators.
uint8 constant OP_GTE = 0;
uint8 constant OP_LTE = 1;

/// @dev Price sources.
uint8 constant SRC_CHAINLINK = 0;
uint8 constant SRC_PYTH = 1;

/// @dev Approve modes.
uint8 constant APPROVE_PARTIES = 0; // both sender and recipient tap OK
uint8 constant APPROVE_REFEREE = 1; // named referee decides (release to recipient or return to sender only)

/// @notice One typed condition. Static struct: `keccak256(abi.encode(c))` is the condition hash that
///         link signatures commit to. Unused fields MUST be zero (enforced by the evaluator).
/// @dev    Prices are 8-decimal "feed units". For Stock Tokens the Chainlink feed ALREADY includes the
///         ERC-8056 multiplier (feed = underlying x multiplier). The UI converts the user's underlying
///         share price to feed units once at creation; the contract never multiplies again. `multiplier`
///         is a snapshot used only to VOID the condition if a corporate action changes it mid-window.
struct Condition {
    Kind kind;
    uint8 mode; //          PRICE: AT_DEADLINE | TOUCH ; APPROVE: PARTIES | REFEREE
    uint8 op; //            PRICE: GTE | LTE
    uint8 source; //        PRICE: CHAINLINK | PYTH
    address target; //      PRICE+CHAINLINK: feed ; APPROVE+REFEREE: referee ; OUTCOME: resolver
    address stockToken; //  PRICE: ERC-8056 token paired with the feed in the registry (0 for crypto feeds)
    bytes32 key; //         PRICE+PYTH: price id ; OUTCOME: question id
    int256 threshold; //    PRICE: 8-decimal feed units
    uint256 multiplier; //  PRICE: uiMultiplier() snapshot at creation (0 when stockToken == 0)
    uint256 outcomeMask; // OUTCOME: bit i set => outcome i counts as "met" (bit 0 = VOID, never allowed)
    uint64 start; //        PRICE+TOUCH: window start
    uint64 deadline; //     TIME: unlock time ; PRICE: deadline
    uint32 maxStale; //     PRICE+AT_DEADLINE: max age of the last round at the deadline
    uint32 holdWindow; //   PRICE+AT_DEADLINE: how long after the deadline to wait for the next print if stale
}

/// @notice Parameters for creating an escrow.
struct CreateParams {
    uint96 amount; //         sender stake (USDG, 6 decimals)
    uint96 counterAmount; //  two-sided only: invitee stake
    address recipient; //     named recipient (exactly one of recipient / linkKey)
    address linkKey; //       claim-link public key (address of the ephemeral key)
    address refundTo; //      primary refund destination (0 => sender)
    address altRefundTo; //   alternate refund destination (0 => none); used if primary cannot receive / transact
    uint64 expiry; //         after this, anyone can refund
    uint64 acceptBy; //       two-sided only: invitee must accept before this
    bool twoSided; //         invite-only challenge: both chip in
    bool cancellable; //      one-sided only: sender may cancel before resolution
    bytes32 salt; //          client-chosen; id = keccak256(abi.encode(sender, salt))
    Condition condition;
}

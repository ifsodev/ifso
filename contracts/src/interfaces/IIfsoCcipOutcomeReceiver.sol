// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice v2 PLAN (not deployed at launch). UMA OOv3 and Chainlink CRE are live on Arbitrum One but not
///         on Robinhood Chain; CCIP is live on both (RHC selector 6180753054346818345, router
///         0x06fC836cf9839B1cd891C440A0a45242DA6Ae1c9). A v2 resolver registers questions on Arbitrum One,
///         settles them there (UMA assertTruth, 2 h liveness + DVM backstop, or a CRE workflow), and a
///         sender contract forwards (questionId, outcome, assertionId) over CCIP to this receiver, which
///         finalizes the matching question on RHC. Allow-listed (sourceChainSelector, sender) only.
interface IIfsoCcipOutcomeReceiver {
    struct BridgedOutcome {
        bytes32 questionId;
        uint8 outcome;
        bytes32 upstreamId; // UMA assertionId or CRE report id on Arbitrum One
        uint64 settledAt;
    }

    event OutcomeBridged(bytes32 indexed questionId, uint8 outcome, bytes32 upstreamId, bytes32 ccipMessageId);

    function allowedSource(uint64 sourceChainSelector, address sender) external view returns (bool);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "../test/utils/TestBase.sol";
import {IfsoEscrow} from "../src/IfsoEscrow.sol";
import {IfsoConditionEvaluator} from "../src/IfsoConditionEvaluator.sol";
import {IfsoOutcomeResolver} from "../src/IfsoOutcomeResolver.sol";
import {FeeRouter} from "../src/FeeRouter.sol";

interface IDecimals {
    function decimals() external view returns (uint8);
}

interface ISafeLike {
    function getThreshold() external view returns (uint256);
    function getOwners() external view returns (address[] memory);
}

/// @notice Shared pieces of the deploy and post-deploy scripts: the armed-flag guard and the assertions.
abstract contract DeployBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant RHC_MAINNET = 4663;
    uint256 internal constant RHC_TESTNET = 46630;
    /// @dev forge's placeholder sender when no wallet is given: never a real deployer.
    address internal constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;

    error NotArmed(uint256 chainId);
    error CheckFailed(string what);

    /// @notice Everything the deployment is expected to look like, read back by the assertions.
    struct Expect {
        address deployer;
        address ownerMultisig;
        address panel;
        address creator;
        address usdg;
        address pyth;
        address seqFeed;
        address[4] feeRecipients; // work, treasury, perks, burn
        uint96 creationFee;
        uint96 resolverFee;
        uint96 bond;
        uint96 maxAmount;
        uint64 disputeWindow;
        uint64 panelWindow;
        address[] feeds;
        address[] feedTokens;
    }

    function _isRealChain() internal view returns (bool) {
        return block.chainid == RHC_MAINNET || block.chainid == RHC_TESTNET;
    }

    /// @notice Refuses to run on Robinhood Chain (4663 / 46630) unless IFSO_ARMED=1 AND the file
    ///         `contracts/.armed-<chainid>` exists (gitignored; created by hand right before a real deploy).
    function _requireArmed() internal view {
        if (!_isRealChain()) return;
        bool envArmed = keccak256(bytes(vm.envOr("IFSO_ARMED", string("0")))) == keccak256("1");
        bool fileArmed = vm.exists(string.concat(".armed-", vm.toString(block.chainid)));
        if (!envArmed || !fileArmed) revert NotArmed(block.chainid);
    }

    function _check(bool ok, string memory what) internal pure {
        if (!ok) revert CheckFailed(what);
    }

    /// @dev Owner is either still the deployer with the multisig pending (right after deploy) or the multisig itself
    ///      (after it called acceptOwnership). Anything else fails.
    function _checkOwner(address c, Expect memory x, string memory name) internal view {
        (bool ok1, bytes memory o) = c.staticcall(abi.encodeWithSignature("owner()"));
        (bool ok2, bytes memory p) = c.staticcall(abi.encodeWithSignature("pendingOwner()"));
        _check(ok1 && ok2, string.concat(name, ": owner getters"));
        address owner_ = abi.decode(o, (address));
        address pending = abi.decode(p, (address));
        bool handedOver = owner_ == x.ownerMultisig && pending == address(0);
        bool pendingHandover = owner_ == x.deployer && pending == x.ownerMultisig;
        _check(handedOver || pendingHandover, string.concat(name, ": owner/pendingOwner is not the multisig"));
    }

    /// @dev On real chains the owner and the panel must be multisigs: contract code that is not an EIP-7702
    ///      delegation, threshold >= 2. (Full Safe singleton/codehash proof is part of the release gate.)
    function _checkMultisig(address a, string memory name) internal view {
        if (!_isRealChain()) return;
        bytes memory code = a.code;
        _check(code.length > 0, string.concat(name, ": no code (an EOA)"));
        _check(
            !(code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00),
            string.concat(name, ": EIP-7702 delegated EOA")
        );
        _check(ISafeLike(a).getThreshold() >= 2, string.concat(name, ": threshold < 2"));
    }

    /// @notice Post-deploy assertions (DEP-2). Reverts with the first mismatch.
    function _assertDeployment(
        IfsoConditionEvaluator evaluator,
        IfsoOutcomeResolver resolver,
        FeeRouter router,
        IfsoEscrow escrow,
        Expect memory x
    ) internal view {
        _check(IDecimals(x.usdg).decimals() == 6, "USDG decimals != 6");
        _checkMultisig(x.ownerMultisig, "owner multisig");
        _checkMultisig(x.panel, "panel multisig");
        _check(x.ownerMultisig != x.panel, "owner and panel must be different signer sets");

        _checkOwner(address(evaluator), x, "evaluator");
        _checkOwner(address(resolver), x, "resolver");
        _checkOwner(address(router), x, "router");
        _checkOwner(address(escrow), x, "escrow");

        // escrow wiring, fees, launch cap
        _check(address(escrow.usdg()) == x.usdg, "escrow.usdg");
        _check(address(escrow.evaluator()) == address(evaluator), "escrow.evaluator");
        _check(escrow.feeRouter() == address(router), "escrow.feeRouter");
        _check(escrow.creationFee() == x.creationFee, "escrow.creationFee");
        _check(escrow.resolverFee() == x.resolverFee, "escrow.resolverFee");
        _check(escrow.maxAmount() == x.maxAmount, "escrow.maxAmount (launch cap)");
        _check(!escrow.creationPaused(), "escrow paused");

        // evaluator registry
        _check(address(evaluator.pyth()) == x.pyth, "evaluator.pyth");
        _check(address(evaluator.sequencerUptimeFeed()) == x.seqFeed, "evaluator.sequencerUptimeFeed");
        _check(evaluator.resolverAllowed(address(resolver)), "resolver not registered in evaluator");
        for (uint256 i; i < x.feeds.length; ++i) {
            _check(evaluator.feedAllowed(x.feeds[i]), "feed not registered");
            _check(evaluator.feedStockToken(x.feeds[i]) == x.feedTokens[i], "feed stock token mismatch");
        }

        // resolver panel, bond, windows, creator
        _check(resolver.bondToken() == x.usdg, "resolver.bondToken");
        _check(resolver.panel() == x.panel, "resolver.panel");
        _check(resolver.bondAmount() == x.bond, "resolver.bondAmount");
        _check(resolver.disputeWindow() == x.disputeWindow, "resolver.disputeWindow");
        _check(resolver.panelWindow() == x.panelWindow, "resolver.panelWindow");
        _check(resolver.isCreator(x.creator), "resolver creator not registered");

        // fee router
        _check(router.usdg() == x.usdg, "router.usdg");
        _check(router.work() == x.feeRecipients[0], "router.work");
        _check(router.treasury() == x.feeRecipients[1], "router.treasury");
        _check(router.perks() == x.feeRecipients[2], "router.perks");
        _check(router.burn() == x.feeRecipients[3], "router.burn");
    }
}

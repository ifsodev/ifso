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
    function getModulesPaginated(address start, uint256 pageSize)
        external
        view
        returns (address[] memory array, address next);
}

/// @notice Shared pieces of the deploy and post-deploy scripts: the armed-flag guard and the assertions.
abstract contract DeployBase {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant RHC_MAINNET = 4663;
    uint256 internal constant RHC_TESTNET = 46630;
    /// @dev forge's placeholder sender when no wallet is given: never a real deployer.
    address internal constant FORGE_DEFAULT_SENDER = 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38;
    /// @dev Launch cap ceiling on Robinhood Chain (DECISIONS #6: 1,000 USDG per escrow side for the first 14 days).
    uint96 internal constant LAUNCH_CAP_CEILING = 1_000e6;

    // Official Safe contracts, checked on 4663 (codesize + codehash, docs/research chain facts, 2026-10-30).
    address internal constant SAFE_L2_141 = 0x29fcB43b46531BcA003ddC8FCB67FFE91900C762;
    address internal constant SAFE_L2_130 = 0x3E5c63644E683549055b9Be8653de26E0B4CD36E;
    address internal constant SAFE_L2_130_EIP155 = 0xfb1bffC9d739B8D520DaF37dF666da4C687191EA;
    /// @dev Runtime codehash of a SafeProxy made by the official 1.4.1 / 1.3.0 factories (measured on a 4663 fork).
    bytes32 internal constant SAFE_PROXY_141_CODEHASH =
        0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c; // not-a-key: codehash
    bytes32 internal constant SAFE_PROXY_130_CODEHASH =
        0xb89c1b3bdf2cf8827818646bce9a8f6e372885f8c55e5c07acbd307cb133b000; // not-a-key: codehash
    /// @dev The Safe transaction guard slot.
    bytes32 internal constant SAFE_GUARD_SLOT = keccak256("guard_manager.guard.address");
    address internal constant SAFE_SENTINEL = address(0x1);

    error NotArmed(uint256 chainId);
    error CheckFailed(string what);
    error NotForkDryRun();

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

    /// @notice Refuses to run on ANY chain but a local anvil (31337) unless IFSO_ARMED=1 AND the file
    ///         `contracts/.armed-<chainid>` exists (gitignored; created by hand right before a real deploy). Covers
    ///         Robinhood Chain and every other real network a mistaken --rpc-url could point at (R1-I6).
    ///         The only other way through is a fork dry run of 4663 (see `_isForkDryRun`).
    function _requireArmed() internal {
        if (block.chainid == 31337) return;
        if (_isForkDryRun()) return;
        bool envArmed = keccak256(bytes(vm.envOr("IFSO_ARMED", string("0")))) == keccak256("1");
        bool fileArmed = vm.exists(string.concat(".armed-", vm.toString(block.chainid)));
        if (!envArmed || !fileArmed) revert NotArmed(block.chainid);
    }

    /// @notice Fork dry run: IFSO_FORK_DRYRUN=1 on chain 4663 is accepted ONLY when the connected node is a local
    ///         anvil fork. A fork keeps the real chain id (4663), so the chain id cannot tell a fork from the real
    ///         network; the node can: `web3_clientVersion` must start with "anvil/" and the anvil-only
    ///         `anvil_nodeInfo` method must answer. A real RPC fails both (the second one reverts the script).
    ///         script/fork-dryrun.sh runs it against `anvil --fork-url <public RPC> -p <port>` on 127.0.0.1.
    function _isForkDryRun() internal returns (bool) {
        if (block.chainid != RHC_MAINNET) return false;
        if (keccak256(bytes(vm.envOr("IFSO_FORK_DRYRUN", string("0")))) != keccak256("1")) return false;
        // vm.rpc returns the JSON result ABI-encoded: a JSON string comes back as abi.encode(string)
        bytes memory client = bytes(abi.decode(vm.rpc("web3_clientVersion", "[]"), (string)));
        bytes memory prefix = bytes("anvil/");
        if (client.length < prefix.length) revert NotForkDryRun();
        for (uint256 i; i < prefix.length; ++i) {
            if (client[i] != prefix[i]) revert NotForkDryRun();
        }
        vm.rpc("anvil_nodeInfo", "[]"); // reverts on any non-anvil node
        return true;
    }

    /// @notice Where the deployment record lives: `deployments/<chainid>.json`, or `deployments/<chainid>-fork.json`
    ///         for a fork dry run (gitignored), so a dry run can never look like a real deployment record.
    function _deploymentPath() internal returns (string memory) {
        string memory id = vm.toString(block.chainid);
        if (_isForkDryRun()) return string.concat("deployments/", id, "-fork.json");
        return string.concat("deployments/", id, ".json");
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

    /// @dev On real chains the owner and the panel must be real Safes (R1-L4): an official SafeProxy (runtime
    ///      codehash), pointing at an official SafeL2 1.4.1 / 1.3.0 singleton, threshold >= 2, no module enabled
    ///      (a module bypasses the threshold) and no transaction guard. An EOA, an EIP-7702 delegated EOA or a
    ///      look-alike contract fails the codehash check.
    function _checkMultisig(address a, string memory name) internal view {
        if (!_isRealChain()) return;
        _check(a.code.length > 0, string.concat(name, ": no code (an EOA)"));
        bytes32 h = a.codehash;
        _check(
            h == SAFE_PROXY_141_CODEHASH || h == SAFE_PROXY_130_CODEHASH,
            string.concat(name, ": not an official SafeProxy (codehash)")
        );
        address singleton = address(uint160(uint256(vm.load(a, bytes32(0)))));
        _check(
            singleton == SAFE_L2_141 || singleton == SAFE_L2_130 || singleton == SAFE_L2_130_EIP155,
            string.concat(name, ": singleton is not an official SafeL2 1.4.1 / 1.3.0")
        );
        _check(ISafeLike(a).getThreshold() >= 2, string.concat(name, ": threshold < 2"));
        (address[] memory modules,) = ISafeLike(a).getModulesPaginated(SAFE_SENTINEL, 1);
        _check(modules.length == 0, string.concat(name, ": a Safe module is enabled"));
        _check(vm.load(a, SAFE_GUARD_SLOT) == bytes32(0), string.concat(name, ": a Safe guard is set"));
    }

    function _checkPythOff(address pyth) internal view {
        _check(!_isRealChain() || pyth == address(0), "Pyth must be off (pyth = 0) on RHC in v1");
    }

    /// @dev On Robinhood Chain the launch cap must be on and at most 1,000 USDG (R1-L4); MAX_AMOUNT=0 fails.
    function _checkLaunchCap(uint96 maxAmount) internal view {
        if (!_isRealChain()) return;
        _check(maxAmount != 0 && maxAmount <= LAUNCH_CAP_CEILING, "launch cap must be 1..1,000 USDG on RHC");
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
        _checkLaunchCap(escrow.maxAmount());
        _check(!escrow.creationPaused(), "escrow paused");

        // evaluator registry
        _check(address(evaluator.pyth()) == x.pyth, "evaluator.pyth");
        // R1-L2: Pyth stays off in v1 on Robinhood Chain. The adapter is immutable, so with pyth = 0 no owner call
        // can switch the unproven path on; enabling it is a new evaluator + escrow deploy and a new review round.
        _checkPythOff(x.pyth);
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

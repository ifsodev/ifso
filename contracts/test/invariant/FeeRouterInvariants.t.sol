// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TestBase, Vm} from "../utils/TestBase.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {MockUSDG} from "../../src/mocks/MockUSDG.sol";
import {IfsoOutcomeResolver} from "../../src/IfsoOutcomeResolver.sol";

/// @notice Drives FeeRouter: fee inflows of any size (including amounts that do not divide by 20, so rounding is
///         exercised), permissionless distribute, owner recipient changes (including one address in two roles),
///         an issuer freeze on a recipient (distribute must revert as a whole, never pay part), sweeps of a stray
///         token, attempted sweeps of USDG, and forfeited dispute bonds forwarded by a REAL IfsoOutcomeResolver
///         wired to this router (audit M-1 inflow: panel answer or panel silence). Expected transfers are computed here from the documented 80/10/5/5
///         rule, never read back from the router.
contract FeeRouterHandler {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    FeeRouter public immutable router;
    MockUSDG public immutable usdg;
    MockUSDG public immutable stray;
    address public immutable owner;
    address[6] public pool; // every address that can ever be a recipient

    uint256 public totalIn; // USDG that reached the router
    mapping(address => uint256) public expectedOut; // per address, from the 80/10/5/5 rule
    uint256 public maxDust; // largest (work paid - floor(80%)) seen; documented bound is 3 base units
    bool public stuckAfterDistribute; // a successful distribute left USDG in the router
    bool public usdgSwept; // sweep(USDG) succeeded
    uint256 public nDistribute;
    uint256 public nDistributeRefused;
    uint256 public nSetRecipients;
    uint256 public nSweep;
    uint256 public nFund;
    uint256 public nForfeit;
    IfsoOutcomeResolver public resolver;
    address public constant R_CREATOR = address(0xC0E);
    address public constant R_PANEL = address(0x9A9E1);
    address public constant R_A = address(0xA11); // proposer
    address public constant R_B = address(0xB22); // disputer
    uint256 internal qn;

    function setResolver(IfsoOutcomeResolver r) external {
        resolver = r;
        address[2] memory who = [R_A, R_B];
        for (uint256 i; i < 2; ++i) {
            usdg.mint(who[i], 1e15);
            vm.prank(who[i]);
            usdg.approve(address(r), type(uint256).max);
        }
    }

    /// @dev One disputed question on the real resolver, then forwardForfeits: the forfeited halves are new inflow.
    function forfeit(uint8 answer, bool silent) external {
        uint64 close = uint64(block.timestamp) + 1;
        vm.prank(R_CREATOR);
        bytes32 id = resolver.createQuestion(keccak256(abi.encode(++qn)), close, close + 1, 3, "");
        vm.warp(close + 1);
        vm.prank(R_A);
        resolver.propose(id, 1, bytes32(0));
        vm.prank(R_B);
        resolver.dispute(id, bytes32(0));
        if (silent) {
            vm.warp(block.timestamp + 72 hours);
            resolver.finalizeTimedOut(id);
        } else {
            vm.prank(R_PANEL);
            resolver.panelResolve(id, answer % 4);
        }
        uint256 f = resolver.forfeited();
        uint256 before = usdg.balanceOf(address(router));
        resolver.forwardForfeits();
        totalIn += usdg.balanceOf(address(router)) - before;
        if (usdg.balanceOf(address(router)) - before != f) totalIn = type(uint256).max; // forward must move all of f
        ++nForfeit;
    }

    constructor(FeeRouter r, MockUSDG u, MockUSDG s, address owner_, address[6] memory pool_) {
        router = r;
        usdg = u;
        stray = s;
        owner = owner_;
        pool = pool_;
    }

    function fund(uint64 amount) external {
        uint256 a = 1 + uint256(amount) % 50_000e6;
        usdg.mint(address(router), a);
        totalIn += a;
        ++nFund;
    }

    function distribute() external {
        uint256 total = usdg.balanceOf(address(router));
        address w = router.work();
        address t = router.treasury();
        address p = router.perks();
        address b = router.burn();
        try router.distribute() {
            if (total == 0) return;
            ++nDistribute;
            uint256 tt = (total * 1000) / 10_000;
            uint256 pp = (total * 500) / 10_000;
            uint256 bb = (total * 500) / 10_000;
            uint256 ww = total - tt - pp - bb;
            expectedOut[w] += ww;
            expectedOut[t] += tt;
            expectedOut[p] += pp;
            expectedOut[b] += bb;
            uint256 dust = ww - (total * 8000) / 10_000;
            if (dust > maxDust) maxDust = dust;
            if (usdg.balanceOf(address(router)) != 0) stuckAfterDistribute = true;
        } catch {
            ++nDistributeRefused;
        }
    }

    function setRecipients(uint8 a, uint8 b, uint8 c, uint8 d) external {
        vm.prank(owner);
        router.setRecipients(pool[a % 6], pool[b % 6], pool[c % 6], pool[d % 6]);
        ++nSetRecipients;
    }

    function freeze(uint8 who, bool on) external {
        usdg.setBlocked(pool[who % 6], on);
    }

    function sweep(bool tryUsdg, uint64 amount) external {
        if (tryUsdg) {
            try router.sweep(address(usdg)) {
                usdgSwept = true;
            } catch {}
            return;
        }
        stray.mint(address(router), amount);
        router.sweep(address(stray));
        ++nSweep;
    }
}

/// @notice Handler-based invariants for FeeRouter (contracts/INVARIANTS.md, FR1-FR4).
///         Default profile: a quick pass. `FOUNDRY_PROFILE=invariant`: 10,000 runs x depth 50.
contract FeeRouterInvariantsTest is TestBase {
    struct FuzzSelector {
        address addr;
        bytes4[] selectors;
    }

    MockUSDG internal usdg;
    MockUSDG internal stray;
    FeeRouter internal router;
    FeeRouterHandler internal handler;
    address internal constant OWNER = address(0x0E1);
    address[6] internal pool =
        [address(0xF001), address(0xF002), address(0xF003), address(0xF004), address(0xF005), address(0xF006)];

    function setUp() public {
        usdg = new MockUSDG();
        stray = new MockUSDG();
        router = new FeeRouter(OWNER, address(usdg), pool[0], pool[1], pool[2], pool[3]);
        handler = new FeeRouterHandler(router, usdg, stray, OWNER, pool);
        IfsoOutcomeResolver resolver = new IfsoOutcomeResolver(
            OWNER, address(usdg), 2 hours, 72 hours, 100e6, handler.R_PANEL(), address(router)
        );
        address rCreator = handler.R_CREATOR();
        vm.prank(OWNER);
        resolver.setCreator(rCreator, true);
        handler.setResolver(resolver);
    }

    function targetContracts() public view returns (address[] memory t) {
        t = new address[](1);
        t[0] = address(handler);
    }

    function targetSelectors() public view returns (FuzzSelector[] memory s) {
        bytes4[] memory sel = new bytes4[](9);
        sel[0] = FeeRouterHandler.fund.selector;
        sel[1] = FeeRouterHandler.distribute.selector;
        sel[2] = FeeRouterHandler.setRecipients.selector;
        sel[3] = FeeRouterHandler.freeze.selector;
        sel[4] = FeeRouterHandler.sweep.selector;
        sel[5] = FeeRouterHandler.fund.selector; // weighted: inflow and distribute dominate
        sel[6] = FeeRouterHandler.distribute.selector;
        sel[7] = FeeRouterHandler.distribute.selector;
        sel[8] = FeeRouterHandler.forfeit.selector; //         real resolver inflow (audit M-1)
        s = new FuzzSelector[](1);
        s[0] = FuzzSelector(address(handler), sel);
    }

    function _paidOut() internal view returns (uint256 sum) {
        for (uint256 i; i < 6; ++i) {
            sum += usdg.balanceOf(pool[i]);
        }
    }

    /// @notice FR1: conservation. Every USDG unit that reached the router is either still in it or was paid to a
    ///         configured recipient; nothing leaves to anyone else (USDG sweep is refused).
    function invariant_FeeRouterConserves() public view {
        assertEq(usdg.balanceOf(address(router)) + _paidOut(), handler.totalIn(), "FR1: USDG in != held + paid");
        assertFalse(handler.usdgSwept(), "FR1: sweep moved USDG");
    }

    /// @notice FR2: each recipient received exactly its 80/10/5/5 share of every distribute, computed with the
    ///         recipients configured at that moment (one address in two roles gets both shares).
    function invariant_FeeRouterExactSplit() public view {
        for (uint256 i; i < 6; ++i) {
            assertEq(usdg.balanceOf(pool[i]), handler.expectedOut(pool[i]), "FR2: recipient paid != its share");
        }
    }

    /// @notice FR3: no dust is stuck. A successful distribute empties the router, and the rounding remainder
    ///         (at most 3 base units, i.e. 0.000003 USDG) goes to the work share.
    function invariant_FeeRouterNoStuckDust() public view {
        assertFalse(handler.stuckAfterDistribute(), "FR3: USDG left in the router after distribute");
        assertTrue(handler.maxDust() <= 3, "FR3: rounding remainder above 3 base units");
    }

    /// @notice The handler reaches every path, and a frozen recipient refuses the whole distribute (no partial pay).
    function test_FeeRouterHandlerReachesEveryPath() public {
        handler.fund(1_234_567); //                            not a multiple of 20: rounding remainder
        handler.distribute();
        handler.setRecipients(0, 0, 4, 5); //                  one address in two roles
        handler.fund(999_999);
        handler.freeze(4, true);
        handler.distribute(); //                               refused as a whole
        assertEq(usdg.balanceOf(address(router)), 1_000_000, "freeze: router keeps everything");
        handler.freeze(4, false);
        handler.distribute();
        handler.sweep(false, 5);
        handler.sweep(true, 0);
        handler.forfeit(1, false); //                          panel answers: loser's half
        handler.forfeit(0, true); //                           panel silent: both halves
        assertEq(usdg.balanceOf(address(router)), 150e6, "forfeits reached the router");
        handler.distribute();
        assertTrue(handler.nDistribute() == 3 && handler.nDistributeRefused() == 1, "distribute paths");
        assertEq(handler.nForfeit(), 2, "forfeit path");
        assertTrue(handler.nSetRecipients() == 1 && handler.nSweep() == 1 && handler.maxDust() > 0, "other paths");
        invariant_FeeRouterConserves();
        invariant_FeeRouterExactSplit();
        invariant_FeeRouterNoStuckDust();
    }
}

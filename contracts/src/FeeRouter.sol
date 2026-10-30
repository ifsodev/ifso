// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "./interfaces/IERC20.sol";
import {Owned2Step} from "./utils/Owned2Step.sol";
import {SafeTransferLib} from "./libraries/SafeTransferLib.sol";

/// @title  FeeRouter
/// @notice Receives IFSO's flat fees (creation fee, resolver fee) and splits them 80/10/5/5:
///         work (infra, keepers, resolver bonds, gas sponsorship) / treasury / holder-perks budget (funds
///         premium discounts, never paid to wallets) / buy-and-burn executor. Holds ONLY fee revenue;
///         escrowed payments never pass through here.
contract FeeRouter is Owned2Step {
    using SafeTransferLib for address;

    event Distributed(uint256 total, uint256 work, uint256 treasury, uint256 perks, uint256 burn);
    event RecipientsSet(address work, address treasury, address perks, address burn);
    event Swept(address indexed token, address indexed to, uint256 amount);
    error NotSweepable();

    uint256 public constant WORK_BPS = 8000;
    uint256 public constant TREASURY_BPS = 1000;
    uint256 public constant PERKS_BPS = 500;
    uint256 public constant BURN_BPS = 500;

    address public immutable usdg;
    address public work;
    address public treasury;
    address public perks;
    address public burn;

    constructor(address owner_, address usdg_, address work_, address treasury_, address perks_, address burn_)
        Owned2Step(owner_)
    {
        if (usdg_ == address(0)) revert ZeroAddress();
        usdg = usdg_;
        _set(work_, treasury_, perks_, burn_);
    }

    /// @notice Changes the four fee split destinations (80 / 10 / 5 / 5).
    /// @param work_ Receives 80% (work).
    /// @param treasury_ Receives 10% (treasury).
    /// @param perks_ Receives 5% (perks).
    /// @param burn_ Receives 5% (burn).
    function setRecipients(address work_, address treasury_, address perks_, address burn_) external onlyOwner {
        _set(work_, treasury_, perks_, burn_);
    }

    function _set(address w, address t, address p, address b) private {
        if (w == address(0) || t == address(0) || p == address(0) || b == address(0)) revert ZeroAddress();
        work = w;
        treasury = t;
        perks = p;
        burn = b;
        emit RecipientsSet(w, t, p, b);
    }

    /// @notice Permissionless: splits the router's whole USDG balance.
    function distribute() external {
        uint256 total = IERC20(usdg).balanceOf(address(this));
        if (total == 0) return;
        uint256 t = (total * TREASURY_BPS) / 10_000;
        uint256 p = (total * PERKS_BPS) / 10_000;
        uint256 b = (total * BURN_BPS) / 10_000;
        uint256 w = total - t - p - b; // rounding dust goes to work
        usdg.safeTransfer(work, w);
        usdg.safeTransfer(treasury, t);
        usdg.safeTransfer(perks, p);
        usdg.safeTransfer(burn, b);
        emit Distributed(total, w, t, p, b);
    }

    /// @notice Tokens other than USDG sent here by mistake go to the treasury.
    /// @param token Token to forward (any token except USDG).
    function sweep(address token) external {
        if (token == usdg) revert NotSweepable();
        uint256 bal = IERC20(token).balanceOf(address(this));
        token.safeTransfer(treasury, bal);
        emit Swept(token, treasury, bal);
    }
}

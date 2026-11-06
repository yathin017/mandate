// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Market readings a policy turns into a risk mode. Never reverts for market reasons: an unusable reference
///         price is reported as `priced = false`, and the policy pauses.
interface IMarketOracle {
    /// @dev Prices are `quoteRaw * 1e36 / baseRaw`. Depth is in raw base units.
    struct Health {
        /// @dev False when the pool cannot price (no history for the window, unknown pair, extreme tick).
        bool priced;
        uint256 spotX36;
        /// @dev Time-weighted average over the long window (the reference price).
        uint256 twapX36;
        /// @dev Time-weighted average over the short window; its distance from `twapX36` is the volatility proxy.
        uint256 shortTwapX36;
        /// @dev Base the trusted liquidity absorbs or supplies before the price moves `bandBps`, smaller side.
        uint256 trustedDepthBase;
        /// @dev Seconds since the pool was initialised.
        uint32 poolAge;
    }

    function health(address base, address quote, uint32 window, uint32 shortWindow, uint16 bandBps)
        external
        view
        returns (Health memory);
}

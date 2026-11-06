// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceAnchor
/// @notice External reference price the quoter compares every fill against (Uniswap v4 TWAP in production).
/// @dev Chain- and venue-specific adapters implement this, so the quoter never depends on a given DEX.
interface IPriceAnchor {
    /// @notice Time-weighted price of `base` in `quote` over the last `window` seconds.
    /// @dev MUST revert if the pair is not the one this anchor tracks or if history is insufficient.
    ///      Never return a fallback price: the quoter treats the return value as trusted.
    /// @return twapPriceX36 `quoteRaw * 1e36 / baseRaw`
    function consult(address base, address quote, uint32 window) external view returns (uint256 twapPriceX36);
}

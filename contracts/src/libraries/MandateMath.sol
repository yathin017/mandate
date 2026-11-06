// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title MandateMath
/// @notice Pure math shared by the quote path, the swap path and the read views, so they can never diverge.
/// @dev Rounding always favours the maker (the treasury): output floors, input ceils.
library MandateMath {
    uint256 internal constant BPS = 10_000;
    /// @dev Prices are `quoteRaw * PRICE_SCALE / baseRaw`. 1e36 keeps >= 18 significant digits even for an
    ///      18-decimal base priced in a 6-decimal quote at fractions of a cent.
    uint256 internal constant PRICE_SCALE = 1e36;

    error ZeroBalance(uint256 balanceIn, uint256 balanceOut);
    error InsufficientLiquidity(uint256 amountOut, uint256 balanceOut);
    error InvalidSpread(uint256 spreadBps);
    error InvalidEpochLength();
    error ZeroAmount();

    // ---------------------------------------------------------------- pricing

    /// @notice Constant-product output for an exact input, after deducting the spread from the input.
    /// @return amountOut floor of `inNet * balanceOut / (balanceIn + inNet)`
    /// @return fee spread kept by the maker, in tokenIn
    function amountOutForExactIn(uint256 balanceIn, uint256 balanceOut, uint256 amountIn, uint256 spreadBps)
        internal
        pure
        returns (uint256 amountOut, uint256 fee)
    {
        _requireBalances(balanceIn, balanceOut);
        fee = feeOf(amountIn, spreadBps);
        uint256 amountInNet = amountIn - fee;
        amountOut = Math.mulDiv(amountInNet, balanceOut, balanceIn + amountInNet);
    }

    /// @notice Constant-product input for an exact output, grossed up by the spread.
    /// @dev `amountIn` is the smallest input whose net-of-spread part buys `amountOut`, so an exact-in swap of
    ///      the returned `amountIn` yields at least `amountOut`.
    /// @return amountIn ceil of the gross input
    /// @return fee spread kept by the maker, in tokenIn (same formula as exact-in)
    function amountInForExactOut(uint256 balanceIn, uint256 balanceOut, uint256 amountOut, uint256 spreadBps)
        internal
        pure
        returns (uint256 amountIn, uint256 fee)
    {
        _requireBalances(balanceIn, balanceOut);
        require(spreadBps < BPS, InvalidSpread(spreadBps));
        require(amountOut < balanceOut, InsufficientLiquidity(amountOut, balanceOut));
        uint256 amountInNet = Math.mulDiv(amountOut, balanceIn, balanceOut - amountOut, Math.Rounding.Ceil);
        amountIn = Math.mulDiv(amountInNet, BPS, BPS - spreadBps, Math.Rounding.Ceil);
        fee = feeOf(amountIn, spreadBps);
    }

    /// @notice Spread portion of a gross input: `amountIn - floor(amountIn * (BPS - spread) / BPS)`.
    function feeOf(uint256 amountIn, uint256 spreadBps) internal pure returns (uint256) {
        require(spreadBps < BPS, InvalidSpread(spreadBps));
        return amountIn - Math.mulDiv(amountIn, BPS - spreadBps, BPS);
    }

    /// @notice Price of base in quote for a pair of amounts.
    function price(uint256 baseAmount, uint256 quoteAmount) internal pure returns (uint256) {
        require(baseAmount > 0, ZeroAmount());
        return Math.mulDiv(quoteAmount, PRICE_SCALE, baseAmount);
    }

    /// @notice `|priceX36 - referenceX36| / referenceX36` in bps, rounded up (strict for the limit check).
    function deviationBps(uint256 priceX36, uint256 referenceX36) internal pure returns (uint256) {
        require(referenceX36 > 0, ZeroAmount());
        uint256 diff = priceX36 > referenceX36 ? priceX36 - referenceX36 : referenceX36 - priceX36;
        return Math.mulDiv(diff, BPS, referenceX36, Math.Rounding.Ceil);
    }

    // ---------------------------------------------------------------- schedule

    /// @notice Linear release: `allotment * clamp((t - start) / duration, 0, 1)`, floored.
    function released(uint256 allotment, uint256 start, uint256 duration, uint256 t) internal pure returns (uint256) {
        if (t < start) return 0;
        if (t >= start + duration) return allotment;
        return Math.mulDiv(allotment, t - start, duration);
    }

    /// @notice Zero-based epoch number at `t`; epochs start at `start`. Before `start` this is epoch 0.
    function epochIndex(uint256 start, uint256 length, uint256 t) internal pure returns (uint256) {
        require(length > 0, InvalidEpochLength());
        return t < start ? 0 : (t - start) / length;
    }

    /// @notice Timestamp at which epoch `index` ends.
    function epochEnd(uint256 start, uint256 length, uint256 index) internal pure returns (uint256) {
        return start + (index + 1) * length;
    }

    function _requireBalances(uint256 balanceIn, uint256 balanceOut) private pure {
        require(balanceIn > 0 && balanceOut > 0, ZeroBalance(balanceIn, balanceOut));
    }
}

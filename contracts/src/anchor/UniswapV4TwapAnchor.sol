// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

import { IPriceAnchor } from "../interfaces/IPriceAnchor.sol";
import { ITickObserver } from "../interfaces/ITickObserver.sol";

/// @title UniswapV4TwapAnchor
/// @notice IPriceAnchor for one Uniswap v4 pool with a MandateOracleHook: returns the time-weighted average price
///         of `BASE` in `QUOTE` over a window, in Mandate's price units (`quoteRaw * 1e36 / baseRaw`).
/// @dev One adapter per (pool, base) pair, immutable. Reverts instead of guessing: unknown pair, zero window, or
///      not enough observation history (the hook's oracle reverts `TargetPredatesOldestObservation`), or a price
///      too small to represent in X36 units (below 1e-36 quote per base, far outside any real market).
///      Uses the untruncated tick accumulator: the geometric-mean TWAP, as in Uniswap v3's OracleLibrary.
contract UniswapV4TwapAnchor is IPriceAnchor {
    using PoolIdLibrary for PoolKey;

    uint256 private constant PRICE_SCALE = 1e36;
    uint256 private constant Q128 = 1 << 128;

    ITickObserver public immutable HOOK;
    PoolId public immutable POOL_ID;
    address public immutable BASE;
    address public immutable QUOTE;
    /// @dev v4 ticks price currency0 in currency1; when base is currency1 the price is inverted.
    bool public immutable BASE_IS_CURRENCY0;

    error ZeroHook();
    error PairNotInPool(address base, address quote);
    error WrongPair(address base, address quote);
    error ZeroWindow();
    error PriceOutOfRange(int24 tick);

    constructor(PoolKey memory key, address base, address quote) {
        require(address(key.hooks) != address(0), ZeroHook());
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        require((base == c0 && quote == c1) || (base == c1 && quote == c0), PairNotInPool(base, quote));

        HOOK = ITickObserver(address(key.hooks));
        POOL_ID = key.toId();
        BASE = base;
        QUOTE = quote;
        BASE_IS_CURRENCY0 = base == c0;
    }

    /// @inheritdoc IPriceAnchor
    function consult(address base, address quote, uint32 window) external view returns (uint256 twapPriceX36) {
        require(base == BASE && quote == QUOTE, WrongPair(base, quote));
        int24 tick = twapTick(window);
        twapPriceX36 = priceAtTick(tick);
        require(twapPriceX36 > 0, PriceOutOfRange(tick));
    }

    /// @notice Arithmetic mean tick over the last `window` seconds, rounded toward negative infinity.
    function twapTick(uint32 window) public view returns (int24) {
        require(window > 0, ZeroWindow());
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        secondsAgos[1] = 0;
        (int56[] memory cumulatives,) = HOOK.observe(secondsAgos, POOL_ID);

        int56 delta = cumulatives[1] - cumulatives[0];
        int56 span = int56(uint56(window));
        // casting to 'int24' is safe because the mean of int24 ticks is itself within int24 range
        // forge-lint: disable-next-line(unsafe-typecast)
        int24 tick = int24(delta / span);
        if (delta < 0 && delta % span != 0) tick--;
        return tick;
    }

    /// @notice Price of BASE in QUOTE at `tick`, as `quoteRaw * 1e36 / baseRaw`. Rounds to 0 at extreme ticks.
    function priceAtTick(int24 tick) public view returns (uint256) {
        uint256 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        // currency1 per currency0 as a Q128 fixed-point number; >= 1 for every valid tick.
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return BASE_IS_CURRENCY0 ? Math.mulDiv(priceX128, PRICE_SCALE, Q128) : Math.mulDiv(PRICE_SCALE, Q128, priceX128);
    }
}

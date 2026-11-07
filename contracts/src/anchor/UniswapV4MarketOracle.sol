// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { SqrtPriceMath } from "@uniswap/v4-core/src/libraries/SqrtPriceMath.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { IMarketOracle } from "../interfaces/IMarketOracle.sol";
import { IPoolHealthSource } from "../interfaces/IPoolHealthSource.sol";

/// @title UniswapV4MarketOracle
/// @notice IMarketOracle for one Uniswap v4 pool with a MandateOracleHook. Reports, in Mandate's price units
///         (`quoteRaw * 1e36 / baseRaw`): the live spot price, the TWAP over a long and a short window, the base
///         depth of the pool's *trusted* liquidity within a price band, and the pool's age. It judges nothing:
///         the issuer's policy turns these readings into a risk mode.
/// @dev One adapter per (pool, base) pair, immutable. Uses the untruncated tick accumulator (geometric-mean TWAP, as
///      in Uniswap v3's OracleLibrary).
///
///      Depth: the base amount that moves the price by `bandBps` against the trusted active liquidity, taking the
///      smaller of the two directions (v4 SqrtPriceMath). It is exact while liquidity is constant across the band,
///      which holds for full-range positions; with concentrated positions it describes the current range only. It is
///      a quantity of base tokens, not a dollar TVL.
contract UniswapV4MarketOracle is IMarketOracle {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 private constant PRICE_SCALE = 1e36;
    uint256 private constant Q128 = 1 << 128;
    uint256 private constant BPS = 10_000;

    IPoolManager public immutable POOL_MANAGER;
    IPoolHealthSource public immutable HOOK;
    PoolId public immutable POOL_ID;
    address public immutable BASE;
    address public immutable QUOTE;
    /// @dev v4 ticks price currency0 in currency1; when base is currency1 the price is inverted.
    bool public immutable BASE_IS_CURRENCY0;

    error ZeroHook();
    error PairNotInPool(address base, address quote);

    /// @param poolManager Canonical v4 PoolManager of the chain, read for the live price and liquidity
    constructor(IPoolManager poolManager, PoolKey memory key, address base, address quote) {
        require(address(key.hooks) != address(0), ZeroHook());
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        require((base == c0 && quote == c1) || (base == c1 && quote == c0), PairNotInPool(base, quote));

        POOL_MANAGER = poolManager;
        HOOK = IPoolHealthSource(address(key.hooks));
        POOL_ID = key.toId();
        BASE = base;
        QUOTE = quote;
        BASE_IS_CURRENCY0 = base == c0;
    }

    /// @inheritdoc IMarketOracle
    function health(address base, address quote, uint32 window, uint32 shortWindow, uint16 bandBps)
        external
        view
        returns (Health memory h)
    {
        if (base != BASE || quote != QUOTE || window == 0 || shortWindow == 0 || shortWindow > window) return h;
        (bool okLong, int24 longTick) = _twapTick(window);
        (bool okShort, int24 shortTick) = _twapTick(shortWindow);
        if (!okLong || !okShort) return h;

        (uint160 sqrtPriceX96, int24 spotTick,,) = POOL_MANAGER.getSlot0(POOL_ID);
        h.spotX36 = priceAtTick(spotTick);
        h.twapX36 = priceAtTick(longTick);
        h.shortTwapX36 = priceAtTick(shortTick);
        if (h.spotX36 == 0 || h.twapX36 == 0 || h.shortTwapX36 == 0) return h;

        h.trustedDepthBase = _depth(sqrtPriceX96, HOOK.trustedLiquidity(POOL_ID), bandBps);
        uint32 initializedAt = HOOK.initializedAt(POOL_ID);
        h.poolAge = initializedAt == 0 ? 0 : uint32(block.timestamp) - initializedAt;
        h.priced = true;
    }

    /// @notice Arithmetic mean tick over `window` seconds, rounded toward negative infinity; false without history.
    function _twapTick(uint32 window) private view returns (bool ok, int24 tick) {
        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        try HOOK.observe(secondsAgos, POOL_ID) returns (int56[] memory cumulatives, int56[] memory) {
            int56 delta = cumulatives[1] - cumulatives[0];
            int56 span = int56(uint56(window));
            // casting to 'int24' is safe because the mean of int24 ticks is itself within int24 range
            // forge-lint: disable-next-line(unsafe-typecast)
            tick = int24(delta / span);
            if (delta < 0 && delta % span != 0) tick--;
            ok = true;
        } catch { }
    }

    /// @dev Base needed to move the price `bandBps` up or down against `liquidity`, whichever is smaller.
    function _depth(uint160 sqrtPriceX96, uint128 liquidity, uint16 bandBps) private view returns (uint256) {
        if (liquidity == 0 || bandBps == 0 || bandBps >= BPS) return 0;
        // sqrt(1 ± band) in 1e18 fixed point, applied to the sqrt price, so the price itself moves by the band.
        uint160 up = _scale(sqrtPriceX96, Math.sqrt((BPS + bandBps) * 1e32));
        uint160 down = _scale(sqrtPriceX96, Math.sqrt((BPS - bandBps) * 1e32));
        uint256 toUp;
        uint256 toDown;
        if (BASE_IS_CURRENCY0) {
            // Buying base out of the pool raises the price; selling base into it lowers it.
            toUp = SqrtPriceMath.getAmount0Delta(sqrtPriceX96, up, liquidity, false);
            toDown = SqrtPriceMath.getAmount0Delta(down, sqrtPriceX96, liquidity, false);
        } else {
            // Base is currency1: the pool price (currency1 per currency0) moves the other way.
            toUp = SqrtPriceMath.getAmount1Delta(sqrtPriceX96, up, liquidity, false);
            toDown = SqrtPriceMath.getAmount1Delta(down, sqrtPriceX96, liquidity, false);
        }
        return Math.min(toUp, toDown);
    }

    function _scale(uint160 sqrtPriceX96, uint256 factor1e18) private pure returns (uint160) {
        uint256 scaled = Math.mulDiv(sqrtPriceX96, factor1e18, 1e18);
        if (scaled >= TickMath.MAX_SQRT_PRICE) return TickMath.MAX_SQRT_PRICE - 1;
        if (scaled <= TickMath.MIN_SQRT_PRICE) return TickMath.MIN_SQRT_PRICE + 1;
        return uint160(scaled);
    }

    /// @notice Price of BASE in QUOTE at `tick`, as `quoteRaw * 1e36 / baseRaw`. Rounds to 0 at extreme ticks.
    function priceAtTick(int24 tick) public view returns (uint256) {
        uint256 sqrtPriceX96 = TickMath.getSqrtPriceAtTick(tick);
        // currency1 per currency0 as a Q128 fixed-point number; >= 1 for every valid tick.
        uint256 priceX128 = Math.mulDiv(sqrtPriceX96, sqrtPriceX96, 1 << 64);
        return BASE_IS_CURRENCY0 ? Math.mulDiv(priceX128, PRICE_SCALE, Q128) : Math.mulDiv(PRICE_SCALE, Q128, priceX128);
    }
}

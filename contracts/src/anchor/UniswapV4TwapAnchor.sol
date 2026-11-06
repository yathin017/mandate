// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

import { IPriceAnchor } from "../interfaces/IPriceAnchor.sol";
import { ITickObserver } from "../interfaces/ITickObserver.sol";
import { MandateMath } from "../libraries/MandateMath.sol";

/// @title UniswapV4TwapAnchor
/// @notice IPriceAnchor for one Uniswap v4 pool with a MandateOracleHook: returns the time-weighted average price
///         of `BASE` in `QUOTE` over a window, in Mandate's price units (`quoteRaw * 1e36 / baseRaw`).
///
///         Circuit breaker: if the pool's live spot price is more than `MAX_SPOT_DEVIATION_BPS` away from the TWAP,
///         `consult` reverts. A pump or dump in progress therefore halts treasury fills until arbitrage brings spot
///         back, even though it has not moved the TWAP yet. The TWAP check in the quoter covers sustained moves.
/// @dev One adapter per (pool, base) pair, immutable. Reverts instead of guessing: unknown pair, zero window, or
///      not enough observation history (the hook's oracle reverts `TargetPredatesOldestObservation`), or a price
///      too small to represent in X36 units (below 1e-36 quote per base, far outside any real market).
///      Uses the untruncated tick accumulator: the geometric-mean TWAP, as in Uniswap v3's OracleLibrary.
contract UniswapV4TwapAnchor is IPriceAnchor {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 private constant PRICE_SCALE = 1e36;
    uint256 private constant Q128 = 1 << 128;

    IPoolManager public immutable POOL_MANAGER;
    ITickObserver public immutable HOOK;
    PoolId public immutable POOL_ID;
    address public immutable BASE;
    address public immutable QUOTE;
    /// @dev v4 ticks price currency0 in currency1; when base is currency1 the price is inverted.
    bool public immutable BASE_IS_CURRENCY0;
    /// @dev Max distance between live spot and TWAP before `consult` refuses to price.
    uint16 public immutable MAX_SPOT_DEVIATION_BPS;

    error ZeroHook();
    error PairNotInPool(address base, address quote);
    error WrongPair(address base, address quote);
    error ZeroWindow();
    error PriceOutOfRange(int24 tick);
    error ZeroDeviationLimit();
    error SpotTwapDivergence(uint256 spotX36, uint256 twapX36, uint256 deviationBps, uint256 maxDeviationBps);

    /// @param poolManager Canonical v4 PoolManager of the chain, read for the live spot price
    /// @param maxSpotDeviationBps Circuit-breaker threshold; must be non-zero
    constructor(IPoolManager poolManager, PoolKey memory key, address base, address quote, uint16 maxSpotDeviationBps) {
        require(address(key.hooks) != address(0), ZeroHook());
        require(maxSpotDeviationBps > 0, ZeroDeviationLimit());
        address c0 = Currency.unwrap(key.currency0);
        address c1 = Currency.unwrap(key.currency1);
        require((base == c0 && quote == c1) || (base == c1 && quote == c0), PairNotInPool(base, quote));

        POOL_MANAGER = poolManager;
        HOOK = ITickObserver(address(key.hooks));
        POOL_ID = key.toId();
        BASE = base;
        QUOTE = quote;
        BASE_IS_CURRENCY0 = base == c0;
        MAX_SPOT_DEVIATION_BPS = maxSpotDeviationBps;
    }

    /// @inheritdoc IPriceAnchor
    function consult(address base, address quote, uint32 window) external view returns (uint256 twapPriceX36) {
        require(base == BASE && quote == QUOTE, WrongPair(base, quote));
        uint256 spotPriceX36;
        uint256 deviation;
        (spotPriceX36, twapPriceX36, deviation) = snapshot(window);
        require(
            deviation <= MAX_SPOT_DEVIATION_BPS,
            SpotTwapDivergence(spotPriceX36, twapPriceX36, deviation, MAX_SPOT_DEVIATION_BPS)
        );
    }

    /// @notice Live spot, TWAP and their distance, without enforcing the circuit breaker (for dashboards).
    /// @dev Still reverts on missing history or an unrepresentable TWAP.
    function snapshot(uint32 window)
        public
        view
        returns (uint256 spotPriceX36, uint256 twapPriceX36, uint256 deviationBps)
    {
        int24 meanTick = twapTick(window);
        twapPriceX36 = priceAtTick(meanTick);
        require(twapPriceX36 > 0, PriceOutOfRange(meanTick));
        spotPriceX36 = priceAtTick(spotTick());
        deviationBps = MandateMath.deviationBps(spotPriceX36, twapPriceX36);
    }

    /// @notice Current tick of the pool.
    function spotTick() public view returns (int24 tick) {
        (, tick,,) = POOL_MANAGER.getSlot0(POOL_ID);
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

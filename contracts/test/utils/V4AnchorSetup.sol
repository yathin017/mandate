// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";

import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { MandateOracleHook } from "../../src/hook/MandateOracleHook.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";

import { MandateVenueSetup } from "./MandateVenueSetup.sol";

/// @title V4AnchorSetup
/// @notice Adds a LAUNCH/USDC Uniswap v4 pool with MandateOracleHook on the canonical PoolManager and a
///         UniswapV4MarketOracle over it, plus helpers to move its price. Pool history created here is SYNTHETIC
///         (time-warped on a fork).
abstract contract V4AnchorSetup is MandateVenueSetup {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint24 internal constant POOL_FEE = 3000;
    int24 internal constant TICK_SPACING = 60;
    /// @dev Liquidity added within this many seconds does not count as trusted depth yet.
    uint32 internal constant SETTLE_SECONDS = 10 minutes;
    /// @dev >= blocks per TWAP window (1800s / 12s = 150) with margin; see NOTES.md.
    uint16 internal constant OBSERVATION_CARDINALITY = 300;
    /// @dev Truncation is unused by the anchor; max tick delta keeps the truncated series non-binding.
    int24 internal constant MAX_ABS_TICK_DELTA = TickMath.MAX_TICK;

    IPoolManager internal poolManager;
    MandateOracleHook internal hook;
    PoolSwapTest internal swapRouter;
    PoolModifyLiquidityTest internal liquidityRouter;
    PoolKey internal poolKey;
    UniswapV4MarketOracle internal marketOracle;

    function _setUpV4(IPoolManager pm, uint256 initialPriceX36) internal {
        poolManager = pm;
        hook = _deployHook(pm);
        swapRouter = new PoolSwapTest(pm);
        liquidityRouter = new PoolModifyLiquidityTest(pm);

        launch.mint(address(this), 1e30);
        usdc.mint(address(this), 1e30);
        launch.approve(address(swapRouter), type(uint256).max);
        usdc.approve(address(swapRouter), type(uint256).max);
        launch.approve(address(liquidityRouter), type(uint256).max);
        usdc.approve(address(liquidityRouter), type(uint256).max);

        poolKey = _poolKey(POOL_FEE, TICK_SPACING);
        pm.initialize(poolKey, sqrtPriceX96For(initialPriceX36));
        hook.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY, poolKey.toId());

        // ~100M LAUNCH / 40M USDC of full-range liquidity at 0.40: about 1M LAUNCH moves the price by 2%.
        liquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: 6e19,
                salt: 0
            }),
            ""
        );

        marketOracle = new UniswapV4MarketOracle(pm, poolKey, address(launch), address(usdc));
    }

    /// @dev Places the hook at an address whose low bits encode exactly afterInitialize + beforeAddLiquidity +
    ///      beforeSwap.
    function _deployHook(IPoolManager pm) internal returns (MandateOracleHook) {
        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;
        address target = address(uint160(0x4444) << 144 | flags);
        deployCodeTo(
            "MandateOracleHook.sol:MandateOracleHook", abi.encode(pm, MAX_ABS_TICK_DELTA, SETTLE_SECONDS), target
        );
        return MandateOracleHook(target);
    }

    function _poolKey(uint24 fee, int24 spacing) internal view returns (PoolKey memory) {
        (address c0, address c1) =
            address(launch) < address(usdc) ? (address(launch), address(usdc)) : (address(usdc), address(launch));
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: fee,
            tickSpacing: spacing,
            hooks: IHooks(address(hook))
        });
    }

    /// @notice Swaps on the v4 pool until LAUNCH trades at `priceX36` (USDC per LAUNCH, Mandate units).
    function moveV4PriceTo(uint256 priceX36) internal {
        uint160 target = sqrtPriceX96For(priceX36);
        (uint160 current,,,) = poolManager.getSlot0(poolKey.toId());
        if (target == current) return;
        swapRouter.swap(
            poolKey,
            SwapParams({ zeroForOne: target < current, amountSpecified: -1e29, sqrtPriceLimitX96: target }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
    }

    /// @notice v4 sqrt price (currency1 per currency0, Q96) for a LAUNCH price in Mandate units.
    function sqrtPriceX96For(uint256 priceX36) internal view returns (uint160) {
        uint256 ratioX192 = address(launch) < address(usdc)
            ? Math.mulDiv(priceX36, 1 << 192, 1e36)  // LAUNCH is currency0
            : Math.mulDiv(1e36, 1 << 192, priceX36); // LAUNCH is currency1
        return uint160(Math.sqrt(ratioX192));
    }
}

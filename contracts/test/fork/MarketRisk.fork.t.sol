// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolIdLibrary, PoolKey } from "@uniswap/v4-core/src/types/PoolId.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";

import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { PolicyConfig, RiskMode, RiskReason } from "../../src/libraries/MandateTypes.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { V4AnchorSetup } from "../utils/V4AnchorSetup.sol";

/// @title MarketRiskForkTest
/// @notice Full stack on a mainnet fork: canonical Aqua + AquaSwapVMRouter + Uniswap v4 PoolManager, our hook,
///         market oracle and quoter. Drives the real pool through the attacks the v2 risk modes exist for and checks
///         the treasury's response. Pool history is SYNTHETIC (warped time on a fork).
/// @dev Skipped when the chain's RPC env var is unset.
contract MarketRiskForkTest is V4AnchorSetup {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant PRICE_040 = MandateFixture.SPOT_X36;
    uint256 internal constant PRICE_030 = 3e23;
    uint256 internal constant PRICE_041 = 41e22;
    uint256 internal constant PRICE_060 = 6e23;
    int256 internal constant POOL_LIQUIDITY = 6e19;

    function _venue() internal view override returns (IAqua, ISwapVM) {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        return (IAqua(cfg.aqua), ISwapVM(cfg.swapVmRouter));
    }

    function setUp() public {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        if (bytes(vm.envOr(cfg.rpcEnv, string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ChainConfigLib.selectFork(cfg);
        _setUpPolicy();
        _setUpV4(IPoolManager(cfg.v4PoolManager), PRICE_040);
        _useOracle(address(marketOracle));

        // A first swap grows the observation buffer; then an hour of history at 0.40, which also ages the pool
        // and settles its liquidity.
        moveV4PriceTo(PRICE_040 + 1e20);
        _nextBlock(1 hours);
    }

    function test_healthyPool_isNormalAndFills() public {
        (RiskMode mode, RiskReason reason, IMarketOracle.Health memory h) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Normal));
        assertEq(uint8(reason), uint8(RiskReason.None));
        assertApproxEqRel(h.twapX36, PRICE_040, 1e15);
        assertGt(h.trustedDepthBase, 500_000e18, "deep pool");
        assertGe(h.poolAge, 1 hours);

        uint256 usdcIn = _buyLaunch(order, 10_000e18);
        assertEq(launch.balanceOf(safe), 10 * SHIP_LAUNCH - 10_000e18);
        assertEq(usdc.balanceOf(safe), 10 * SHIP_USDC + usdcIn);
    }

    /// @notice Loophole 1/5: a same-block pump moves spot, not the TWAP. A large move pauses the treasury; once
    ///         arbitrage restores spot, the same fill goes through.
    function test_flashPump_pauses_thenRecovers() public {
        moveV4PriceTo(PRICE_060);
        (RiskMode mode, RiskReason reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Paused));
        assertEq(uint8(reason), uint8(RiskReason.MoveBeyondPause));

        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.MoveBeyondPause));
        taker.quote(order, address(usdc), address(launch), 10_000e18, false);

        moveV4PriceTo(PRICE_040);
        _buyLaunch(order, 10_000e18);
    }

    /// @notice A moderate move only turns the treasury defensive: smaller fills, and no buybacks into the move.
    function test_moderateMove_isDefensive() public {
        moveV4PriceTo(PRICE_041);
        (RiskMode mode, RiskReason reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Defensive));
        assertEq(uint8(reason), uint8(RiskReason.MoveDefensive));

        _buyLaunch(order, 10_000e18);

        launch.mint(address(taker), 1000e18);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.BuybacksNotAllowed.selector, RiskMode.Defensive));
        taker.swap(order, address(launch), address(usdc), 1000e18, true);
    }

    /// @notice Loophole 8: after a sustained crash the TWAP agrees with spot, so the mode is calm, but the strategy's
    ///         stale 0.40 quote is off the market: dumpers cannot exit into the treasury at it.
    function test_sustainedCrash_blocksStaleQuote() public {
        moveV4PriceTo(PRICE_030);
        _nextBlock(TWAP_WINDOW);
        (RiskMode mode,, IMarketOracle.Health memory h) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Normal));
        assertApproxEqRel(h.twapX36, PRICE_030, 1e15);

        launch.mint(address(taker), 10_000e18);
        vm.expectPartialRevert(IMandateQuoter.QuoteOffMarket.selector);
        taker.swap(order, address(launch), address(usdc), 10_000e18, true);
    }

    /// @notice Loophole 1: liquidity pulled out counts at once; liquidity added back is not trusted until it settles,
    ///         so a just-in-time deposit cannot unlock large fills.
    function test_jitLiquidity_isNotTrustedUntilItSettles() public {
        int256 removed = POOL_LIQUIDITY - POOL_LIQUIDITY / 1000;
        _modifyLiquidity(-removed);
        (RiskMode mode, RiskReason reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Paused), "thin pool pauses at once");
        assertEq(uint8(reason), uint8(RiskReason.DepthBelowMinimum));

        _modifyLiquidity(removed);
        (mode, reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(reason), uint8(RiskReason.DepthBelowMinimum), "fresh liquidity not trusted yet");

        _nextBlock(SETTLE_SECONDS + 1);
        (mode, reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Normal), "trusted once settled");
    }

    /// @notice Loophole 6: a pool younger than the policy's minimum age cannot anchor fills, even once its TWAP exists.
    function test_youngPool_pauses() public {
        PoolKey memory fresh = _poolKey(500, 10);
        poolManager.initialize(fresh, sqrtPriceX96For(PRICE_040));
        hook.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY, fresh.toId());
        liquidityRouter.modifyLiquidity(
            fresh,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(10),
                tickUpper: TickMath.maxUsableTick(10),
                liquidityDelta: POOL_LIQUIDITY,
                salt: 0
            }),
            ""
        );
        _useOracle(address(new UniswapV4MarketOracle(poolManager, fresh, address(launch), address(usdc))));

        (, RiskReason reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(reason), uint8(RiskReason.Unpriced), "no TWAP history yet");

        _nextBlock(TWAP_WINDOW + 10 minutes);
        (, reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(reason), uint8(RiskReason.PoolTooYoung));

        _nextBlock(30 minutes);
        (RiskMode mode,,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Normal));
    }

    // ---------------------------------------------------------------- helpers

    uint32 internal constant TWAP_WINDOW = 30 minutes;

    function _useOracle(address o) internal {
        PolicyConfig memory c = registry.getPolicy(POLICY_ID).config;
        c.oracle.oracle = o;
        c.oracle.twapWindow = TWAP_WINDOW;
        registry.setConfig(POLICY_ID, c);
    }

    function _modifyLiquidity(int256 delta) internal {
        liquidityRouter.modifyLiquidity(
            poolKey,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(TICK_SPACING),
                tickUpper: TickMath.maxUsableTick(TICK_SPACING),
                liquidityDelta: delta,
                salt: 0
            }),
            ""
        );
    }

    function _nextBlock(uint256 secondsAhead) internal {
        vm.warp(block.timestamp + secondsAhead);
        vm.roll(block.number + secondsAhead / 12);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
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
import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

/// @notice MandateOracleHook + UniswapV4MarketOracle on the canonical v4 PoolManager (Ethereum fork; skipped without
///         the chain's RPC env var): TWAP readiness, pool age,
///         just-in-time liquidity excluded from trusted depth, removals counted at once, volatility proxy, and depth
///         that really moves the price by the band, in both pool orientations. Values here are test inputs only.
contract MarketOracleForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint32 internal constant SETTLE = 600;
    uint32 internal constant WINDOW = 1800;
    uint32 internal constant SHORT = 300;
    uint16 internal constant BAND = 100; // 1%
    int128 internal constant L0 = 1e18;

    IPoolManager internal pm;
    MandateOracleHook internal hook;
    PoolSwapTest internal swapper;
    PoolModifyLiquidityTest internal lp;
    MockERC20 internal tokenA;
    MockERC20 internal tokenB;
    PoolKey internal key;
    PoolId internal id;
    /// @dev Oracle with base = currency0, and one with base = currency1, over the same pool.
    UniswapV4MarketOracle internal oracle0;
    UniswapV4MarketOracle internal oracle1;
    address internal base0;
    address internal base1;

    function setUp() public {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        if (bytes(vm.envOr(cfg.rpcEnv, string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ChainConfigLib.selectFork(cfg);
        vm.warp(1_800_000_000);
        pm = IPoolManager(cfg.v4PoolManager);
        uint160 flags = Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG;
        address target = address(uint160(0x4444) << 144 | flags);
        deployCodeTo("MandateOracleHook.sol:MandateOracleHook", abi.encode(pm, TickMath.MAX_TICK, SETTLE), target);
        hook = MandateOracleHook(target);
        swapper = new PoolSwapTest(pm);
        lp = new PoolModifyLiquidityTest(pm);

        tokenA = new MockERC20("Token A", "A", 18);
        tokenB = new MockERC20("Token B", "B", 18);
        (base0, base1) = address(tokenA) < address(tokenB) ? (address(tokenA), address(tokenB)) : (address(tokenB), address(tokenA));
        for (uint256 i; i < 2; ++i) {
            MockERC20 t = i == 0 ? tokenA : tokenB;
            t.mint(address(this), 1e40);
            t.approve(address(swapper), type(uint256).max);
            t.approve(address(lp), type(uint256).max);
        }
        key = PoolKey(Currency.wrap(base0), Currency.wrap(base1), 3000, 60, IHooks(address(hook)));
        id = key.toId();
        pm.initialize(key, TickMath.getSqrtPriceAtTick(0));
        hook.increaseObservationCardinalityNext(300, id);
        _liquidity(L0);

        oracle0 = new UniswapV4MarketOracle(pm, key, base0, base1);
        oracle1 = new UniswapV4MarketOracle(pm, key, base1, base0);
    }

    /// @dev The test routers refund any ETH they hold to the caller, and on a fork their fresh addresses may already
    ///      hold some.
    receive() external payable { }

    function _liquidity(int128 delta) internal {
        lp.modifyLiquidity(
            key,
            ModifyLiquidityParams({ tickLower: TickMath.minUsableTick(60), tickUpper: TickMath.maxUsableTick(60), liquidityDelta: delta, salt: 0 }),
            ""
        );
    }

    function _health(UniswapV4MarketOracle o, address base, address quote) internal view returns (IMarketOracle.Health memory) {
        return o.health(base, quote, WINDOW, SHORT, BAND);
    }

    function _spotX36(UniswapV4MarketOracle o) internal view returns (uint256) {
        (, int24 tick,,) = pm.getSlot0(id);
        return o.priceAtTick(tick);
    }

    function test_unpricedUntilTheWindowHasHistory() public {
        assertFalse(_health(oracle0, base0, base1).priced);
        vm.warp(block.timestamp + WINDOW);
        IMarketOracle.Health memory h = _health(oracle0, base0, base1);
        assertTrue(h.priced);
        assertEq(h.poolAge, WINDOW);
        assertEq(h.spotX36, h.twapX36, "flat price: spot equals the TWAP");
        assertEq(h.twapX36, h.shortTwapX36);
    }

    function test_unpricedForWrongPairOrWindows() public {
        vm.warp(block.timestamp + WINDOW);
        assertFalse(oracle0.health(base1, base0, WINDOW, SHORT, BAND).priced, "orientation belongs to the other oracle");
        assertFalse(oracle0.health(base0, base1, WINDOW, WINDOW + 1, BAND).priced, "short window longer than the long one");
        assertFalse(oracle0.health(base0, base1, 0, 0, BAND).priced);
        assertEq(oracle0.health(base0, base1, WINDOW, SHORT, 0).trustedDepthBase, 0, "zero band, zero depth");
    }

    function test_depthIsTheBaseThatMovesThePriceByTheBand_bothOrientations() public {
        vm.warp(block.timestamp + WINDOW);
        for (uint256 i; i < 2; ++i) {
            UniswapV4MarketOracle o = i == 0 ? oracle0 : oracle1;
            (address b, address q) = i == 0 ? (base0, base1) : (base1, base0);
            uint256 depth = _health(o, b, q).trustedDepthBase;
            assertGt(depth, 0);
            uint256 before = _spotX36(o);
            // Buy exactly `depth` base out of the pool: the base price should rise by about the band.
            bool baseIs0 = b == base0;
            uint256 snap = vm.snapshotState();
            swapper.swap(
                key,
                SwapParams({ zeroForOne: !baseIs0, amountSpecified: int256(depth), sqrtPriceLimitX96: baseIs0 ? TickMath.MAX_SQRT_PRICE - 1 : TickMath.MIN_SQRT_PRICE + 1 }),
                PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                ""
            );
            uint256 moveBps = (_spotX36(o) - before) * 10_000 / before;
            // Tick granularity (1 bp per tick) bounds the error.
            assertApproxEqAbs(moveBps, BAND, 2, "price moved by the band");
            vm.revertToState(snap);
        }
    }

    function test_justInTimeLiquidityIsNotTrustedUntilItSettles() public {
        vm.warp(block.timestamp + WINDOW);
        uint256 depthBefore = _health(oracle0, base0, base1).trustedDepthBase;
        _liquidity(L0 * 9); // ten times deeper, right now
        assertEq(pm.getLiquidity(id), uint128(L0 * 10));
        assertEq(hook.trustedLiquidity(id), uint128(L0), "the new liquidity is not trusted yet");
        assertEq(_health(oracle0, base0, base1).trustedDepthBase, depthBefore);

        // A second add inside the window cannot raise the trusted value either.
        vm.warp(block.timestamp + SETTLE / 2);
        _liquidity(L0);
        assertEq(hook.trustedLiquidity(id), uint128(L0));

        vm.warp(block.timestamp + SETTLE);
        assertEq(hook.trustedLiquidity(id), uint128(L0 * 11), "trusted once it has stayed");
        assertApproxEqRel(_health(oracle0, base0, base1).trustedDepthBase, depthBefore * 11, 1e15);
    }

    function test_removalsCountImmediately() public {
        vm.warp(block.timestamp + WINDOW);
        _liquidity(-L0 / 2);
        assertEq(hook.trustedLiquidity(id), uint128(L0 / 2));
        // Remove within a settle window too: trusted never exceeds what is in the pool.
        _liquidity(L0);
        _liquidity(-L0);
        assertEq(hook.trustedLiquidity(id), uint128(L0 / 2));
    }

    function test_shortTwapLeadsTheLongOneAfterAMove() public {
        vm.warp(block.timestamp + WINDOW);
        swapper.swap(
            key,
            SwapParams({ zeroForOne: false, amountSpecified: -1e17, sqrtPriceLimitX96: TickMath.MAX_SQRT_PRICE - 1 }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.warp(block.timestamp + SHORT);
        IMarketOracle.Health memory h = _health(oracle0, base0, base1);
        assertGt(h.spotX36, h.twapX36);
        assertEq(h.shortTwapX36, h.spotX36, "the short window saw only the new price");
        assertLt(h.twapX36, h.shortTwapX36, "the long window still averages the old price");
    }

    function test_hookPermissionsMatchItsAddress() public view {
        Hooks.Permissions memory p = hook.getHookPermissions();
        assertTrue(p.afterInitialize && p.beforeAddLiquidity && p.beforeSwap);
        assertFalse(p.beforeRemoveLiquidity || p.afterAddLiquidity || p.afterSwap);
        assertEq(hook.initializedAt(id), 1_800_000_000);
    }
}

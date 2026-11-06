// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { PoolIdLibrary, PoolKey } from "@uniswap/v4-core/src/types/PoolId.sol";
import { Oracle } from "@openzeppelin/uniswap-hooks/oracles/panoptic/libraries/Oracle.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { UniswapV4TwapAnchor } from "../../src/anchor/UniswapV4TwapAnchor.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { V4AnchorSetup } from "../utils/V4AnchorSetup.sol";

/// @title V4AnchorForkTest
/// @notice Full stack on a mainnet fork: canonical Aqua + AquaSwapVMRouter + Uniswap v4 PoolManager, our hook,
///         anchor adapter and quoter. Pool history is SYNTHETIC (warped time on a fork).
/// @dev Skipped when the chain's RPC env var is unset.
contract V4AnchorForkTest is V4AnchorSetup {
    using PoolIdLibrary for PoolKey;

    uint256 internal constant PRICE_040 = MandateFixture.SPOT_X36; // 0.40
    uint256 internal constant PRICE_030 = 3e23;
    uint256 internal constant PRICE_060 = 6e23;

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
        _setUpMandate();
        _setUpV4(IPoolManager(cfg.v4PoolManager), PRICE_040);

        // A first swap grows the observation buffer; then an hour of history at 0.40.
        moveV4PriceTo(PRICE_040 + 1e20);
        _nextBlock(1 hours);
        registry.setAnchor(ID, address(v4Anchor));
    }

    function test_twapTracksPool() public view {
        assertApproxEqRel(v4Anchor.consult(address(launch), address(usdc), TWAP_WINDOW), PRICE_040, 1e15); // 0.1%
        (uint256 spot, uint256 twap,, bool ok) = quoter.anchorStatus(ID);
        assertEq(spot, PRICE_040);
        assertGt(twap, 0);
        assertTrue(ok);
    }

    function test_treasurySellFills_againstRealTwap() public {
        uint256 usdcIn = _buyLaunch(order, 10_000e18);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH - 10_000e18);
        assertEq(usdc.balanceOf(safe), SHIP_USDC + usdcIn);
    }

    /// @notice A same-block pump moves v4 spot but not the TWAP. The circuit breaker sees spot diverge and halts
    ///         treasury fills; once arbitrage restores spot, the same fill goes through.
    function test_flashPump_tripsCircuitBreaker_thenRecovers() public {
        moveV4PriceTo(PRICE_060);
        (uint256 spot, uint256 twap, uint256 dev) = v4Anchor.snapshot(TWAP_WINDOW);
        assertApproxEqRel(twap, PRICE_040, 1e15, "TWAP unmoved");
        assertApproxEqRel(spot, PRICE_060, 1e15, "spot pumped");
        assertGt(dev, MAX_SPOT_DEVIATION_BPS);

        vm.expectPartialRevert(UniswapV4TwapAnchor.SpotTwapDivergence.selector);
        taker.quote(order, address(usdc), address(launch), 10_000e18, false);

        moveV4PriceTo(PRICE_040);
        _buyLaunch(order, 10_000e18);
    }

    /// @notice After a sustained crash, dumpers cannot exit into the treasury at its stale 0.40 price.
    ///         Once the market recovers, the same trade fills.
    function test_sustainedCrash_blocksStaleExit_thenRecovers() public {
        // While the crash is fresh the circuit breaker halts fills; once it has lasted a full window the TWAP
        // agrees with spot and the anchor check itself is what refuses the stale price.
        moveV4PriceTo(PRICE_030);
        _nextBlock(TWAP_WINDOW);
        assertApproxEqRel(v4Anchor.consult(address(launch), address(usdc), TWAP_WINDOW), PRICE_030, 1e15);

        launch.mint(address(taker), 10_000e18);
        vm.expectPartialRevert(IMandateQuoter.AnchorDeviation.selector);
        taker.quote(order, address(launch), address(usdc), 10_000e18, true);
        vm.expectPartialRevert(IMandateQuoter.AnchorDeviation.selector);
        taker.swap(order, address(launch), address(usdc), 10_000e18, true);

        moveV4PriceTo(PRICE_040);
        _nextBlock(TWAP_WINDOW);
        taker.swap(order, address(launch), address(usdc), 10_000e18, true);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH + 10_000e18, "buyback filled");
    }

    /// @notice Without a grown observation buffer one swap erases history and halts trading (fail-safe),
    ///         which is why setup grows the buffer to cover the window.
    function test_insufficientHistory_haltsTrading() public {
        PoolKey memory fresh = _poolKey(500, 10);
        poolManager.initialize(fresh, sqrtPriceX96For(PRICE_040));
        UniswapV4TwapAnchor freshAnchor =
            new UniswapV4TwapAnchor(poolManager, fresh, address(launch), address(usdc), MAX_SPOT_DEVIATION_BPS);
        registry.setAnchor(ID, address(freshAnchor));

        vm.expectPartialRevert(Oracle.TargetPredatesOldestObservation.selector);
        taker.quote(order, address(usdc), address(launch), 1000e18, false);
    }

    function test_observationBufferGrown() public view {
        (,, uint16 cardinalityNext) = hook.stateById(poolKey.toId());
        assertEq(cardinalityNext, OBSERVATION_CARDINALITY);
    }

    function _nextBlock(uint256 secondsAhead) internal {
        vm.warp(block.timestamp + secondsAhead);
        vm.roll(block.number + secondsAhead / 12);
    }
}

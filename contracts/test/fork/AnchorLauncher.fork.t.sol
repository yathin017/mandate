// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { AnchorLauncher } from "../../src/anchor/AnchorLauncher.sol";
import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { MandateOracleHook } from "../../src/hook/MandateOracleHook.sol";
import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

/// @title AnchorLauncherForkTest
/// @notice AnchorLauncher against the canonical mainnet PoolManager on a fork.
/// @dev Skipped when the chain's RPC env var is unset.
contract AnchorLauncherForkTest is Test {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 internal constant PRICE = 4e23; // 0.40 quote (6dp) per base (18dp)
    uint32 internal constant WINDOW = 30 minutes;

    IPoolManager internal pm;
    MandateOracleHook internal hook;
    AnchorLauncher internal launcher;
    MockERC20 internal base;
    MockERC20 internal quote;

    function setUp() public {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        if (bytes(vm.envOr(cfg.rpcEnv, string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ChainConfigLib.selectFork(cfg);
        pm = IPoolManager(cfg.v4PoolManager);
        hook = _hookAt(pm, 0x4444);
        launcher = new AnchorLauncher(pm, hook);
        base = new MockERC20("Demo Launch", "dLAUNCH", 18);
        quote = new MockERC20("Demo Dollar", "dUSD", 6);
    }

    function test_launch_createsPoolGrowsBufferAndDeploysAnchorAtPredictedAddress() public {
        address predicted = launcher.predictAnchor(address(base), address(quote));
        (UniswapV4MarketOracle anchor, PoolId poolId, bool created) =
            launcher.launch(address(base), address(quote), PRICE);

        assertTrue(created, "pool created");
        assertEq(address(anchor), predicted, "predicted address");
        assertEq(launcher.anchorOf(address(base), address(quote)), address(anchor));
        assertEq(PoolId.unwrap(anchor.POOL_ID()), PoolId.unwrap(poolId), "anchor reads this pool");
        assertEq(anchor.BASE(), address(base));
        assertEq(anchor.QUOTE(), address(quote));
        assertEq(hook.initializedAt(poolId), block.timestamp, "pool age starts at launch");

        (uint160 sqrtPriceX96,,,) = pm.getSlot0(poolId);
        assertEq(sqrtPriceX96, launcher.sqrtPriceX96For(address(base), address(quote), PRICE), "initial price");
        (,, uint16 cardinalityNext) = hook.stateById(poolId);
        assertEq(cardinalityNext, launcher.OBSERVATION_CARDINALITY(), "buffer grown");
    }

    /// @notice The init observation is history: one window after launch the oracle prices without any swap. Before
    ///         that it reports unpriced instead of reverting, so the quoter can pause with a reason.
    function test_oracle_pricesAfterOneWindow_noSwapsNeeded() public {
        (UniswapV4MarketOracle anchor,,) = launcher.launch(address(base), address(quote), PRICE);
        assertFalse(_health(anchor, address(base), address(quote)).priced);

        vm.warp(block.timestamp + WINDOW + 1);
        IMarketOracle.Health memory h = _health(anchor, address(base), address(quote));
        assertTrue(h.priced);
        assertApproxEqRel(h.twapX36, PRICE, 1e14); // within 1 tick
        assertEq(h.trustedDepthBase, 0, "no liquidity yet");
    }

    function test_launch_isIdempotent() public {
        (UniswapV4MarketOracle first, PoolId id1,) = launcher.launch(address(base), address(quote), PRICE);
        (UniswapV4MarketOracle again, PoolId id2, bool created) = launcher.launch(address(base), address(quote), 1);
        assertEq(address(again), address(first));
        assertEq(PoolId.unwrap(id1), PoolId.unwrap(id2));
        assertFalse(created);
    }

    /// @notice The reverse orientation gets its own anchor on the same pool, priced as the inverse.
    function test_reverseOrientation_sharesPool() public {
        (UniswapV4MarketOracle forward, PoolId poolId,) = launcher.launch(address(base), address(quote), PRICE);
        (UniswapV4MarketOracle reverse, PoolId reversePoolId, bool created) =
            launcher.launch(address(quote), address(base), 123);

        assertTrue(address(reverse) != address(forward));
        assertEq(PoolId.unwrap(reversePoolId), PoolId.unwrap(poolId));
        assertFalse(created, "pool reused, price argument ignored");

        vm.warp(block.timestamp + WINDOW + 1);
        uint256 p = _health(forward, address(base), address(quote)).twapX36;
        uint256 inverse = _health(reverse, address(quote), address(base)).twapX36;
        assertApproxEqRel(p * inverse, 1e72, 1e14);
    }

    /// @notice A pool someone else created keeps its own price; the launcher reports it did not create it.
    function test_existingPool_keepsItsPrice() public {
        PoolKey memory key = launcher.poolKeyFor(address(base), address(quote));
        uint160 squatterPrice = launcher.sqrtPriceX96For(address(base), address(quote), 5e23);
        pm.initialize(key, squatterPrice);

        (, PoolId poolId, bool created) = launcher.launch(address(base), address(quote), PRICE);
        assertFalse(created);
        (uint160 sqrtPriceX96,,,) = pm.getSlot0(poolId);
        assertEq(sqrtPriceX96, squatterPrice, "existing price kept");
        (,, uint16 cardinalityNext) = hook.stateById(poolId);
        assertEq(cardinalityNext, launcher.OBSERVATION_CARDINALITY(), "buffer still grown");
    }

    function test_rejects_sameToken() public {
        vm.expectRevert(abi.encodeWithSelector(AnchorLauncher.InvalidPair.selector, address(base), address(base)));
        launcher.launch(address(base), address(base), PRICE);
    }

    function test_rejects_zeroAddress() public {
        vm.expectRevert(abi.encodeWithSelector(AnchorLauncher.InvalidPair.selector, address(0), address(quote)));
        launcher.launch(address(0), address(quote), PRICE);
    }

    function test_rejects_accountWithoutCode() public {
        address empty = address(uint160(uint256(keccak256("AnchorLauncher.test.empty"))));
        assertEq(empty.code.length, 0);
        vm.expectRevert(abi.encodeWithSelector(AnchorLauncher.NotAToken.selector, empty));
        launcher.launch(address(base), empty, PRICE);
    }

    /// @notice A contract that is not an ERC20 (here the PoolManager's hook) is rejected.
    function test_rejects_contractThatIsNotAToken() public {
        vm.expectRevert(abi.encodeWithSelector(AnchorLauncher.NotAToken.selector, address(hook)));
        launcher.launch(address(base), address(hook), PRICE);
    }

    function test_rejects_zeroPrice() public {
        vm.expectRevert(abi.encodeWithSelector(AnchorLauncher.PriceOutOfRange.selector, 0));
        launcher.launch(address(base), address(quote), 0);
    }

    function test_rejects_unrepresentablePrice() public {
        vm.expectRevert();
        launcher.launch(address(base), address(quote), type(uint256).max);
    }

    function test_constructor_rejectsHookOfAnotherPoolManager() public {
        MandateOracleHook foreign = _hookAt(IPoolManager(makeAddr("otherPoolManager")), 0x5555);
        vm.expectRevert(AnchorLauncher.HookPoolManagerMismatch.selector);
        new AnchorLauncher(pm, foreign);
    }

    function _health(UniswapV4MarketOracle o, address b, address q) internal view returns (IMarketOracle.Health memory) {
        return o.health(b, q, WINDOW, 5 minutes, 200);
    }

    /// @dev Places a hook at an address whose low bits encode exactly afterInitialize + beforeAddLiquidity +
    ///      beforeSwap.
    function _hookAt(IPoolManager manager, uint160 prefix) internal returns (MandateOracleHook) {
        address target = address(
            prefix << 144 | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG
        );
        deployCodeTo(
            "MandateOracleHook.sol:MandateOracleHook", abi.encode(manager, TickMath.MAX_TICK, uint32(10 minutes)), target
        );
        return MandateOracleHook(target);
    }
}

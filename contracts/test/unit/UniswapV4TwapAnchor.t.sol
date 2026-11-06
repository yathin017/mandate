// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";

import { UniswapV4TwapAnchor } from "../../src/anchor/UniswapV4TwapAnchor.sol";

import { MockTickObserver } from "../utils/MockTickObserver.sol";

contract UniswapV4TwapAnchorTest is Test {
    address internal constant TOKEN_LO = address(0x1000);
    address internal constant TOKEN_HI = address(0x2000);

    MockTickObserver internal observer;
    UniswapV4TwapAnchor internal baseIs0; // base = currency0
    UniswapV4TwapAnchor internal baseIs1; // base = currency1

    function setUp() public {
        observer = new MockTickObserver();
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(TOKEN_LO),
            currency1: Currency.wrap(TOKEN_HI),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(observer))
        });
        baseIs0 = new UniswapV4TwapAnchor(key, TOKEN_LO, TOKEN_HI);
        baseIs1 = new UniswapV4TwapAnchor(key, TOKEN_HI, TOKEN_LO);
    }

    function test_tickZero_isParity() public view {
        assertEq(baseIs0.priceAtTick(0), 1e36);
        assertEq(baseIs1.priceAtTick(0), 1e36);
    }

    function test_orientation_isInverse() public view {
        int24 tick = -284_000; // ~0.46 USDC(6dp) per 18dp token
        uint256 p0 = baseIs0.priceAtTick(tick);
        uint256 p1 = baseIs1.priceAtTick(tick);
        // p0 * p1 == 1e72 within rounding
        assertApproxEqRel(p0 * p1, 1e72, 1e9);
    }

    /// @notice One tick is one basis point of price (1.0001x).
    function test_oneTickIsOneBp() public view {
        uint256 p = baseIs0.priceAtTick(-284_000);
        uint256 pUp = baseIs0.priceAtTick(-283_999);
        assertApproxEqRel(pUp * 10_000, p * 10_001, 1e10);
    }

    /// @notice A real-world scale check: 0.40 USDC (6dp) per 18dp LAUNCH = raw ratio 4e-13 = 4e23 in X36.
    function test_launchUsdcScale() public view {
        // tick = floor(log_1.0001(4e-13)) = -285_488, whose price is 3.99976e23
        uint256 p = baseIs0.priceAtTick(-285_488);
        assertApproxEqRel(p, 4e23, 1e14); // within 1 tick (0.01%)
    }

    function test_twapTick_meanOverWindow() public {
        observer.set(0, -100 * 1800);
        assertEq(baseIs0.twapTick(1800), -100);
    }

    function test_twapTick_roundsTowardNegativeInfinity() public {
        observer.set(0, -1801); // mean -1.0005..
        assertEq(baseIs0.twapTick(1800), -2);
        observer.set(0, 1801); // mean 1.0005..
        assertEq(baseIs0.twapTick(1800), 1);
    }

    function test_consult_returnsTwapPrice() public {
        observer.set(1000, 1000 + int56(-285_488) * 1800);
        assertEq(baseIs0.consult(TOKEN_LO, TOKEN_HI, 1800), baseIs0.priceAtTick(-285_488));
    }

    function test_consult_revertsOnWrongPair() public {
        vm.expectRevert(abi.encodeWithSelector(UniswapV4TwapAnchor.WrongPair.selector, TOKEN_HI, TOKEN_LO));
        baseIs0.consult(TOKEN_HI, TOKEN_LO, 1800);
    }

    function test_consult_revertsOnZeroWindow() public {
        vm.expectRevert(UniswapV4TwapAnchor.ZeroWindow.selector);
        baseIs0.consult(TOKEN_LO, TOKEN_HI, 0);
    }

    function test_constructor_revertsWhenPairNotInPool() public {
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(TOKEN_LO),
            currency1: Currency.wrap(TOKEN_HI),
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(observer))
        });
        vm.expectRevert(abi.encodeWithSelector(UniswapV4TwapAnchor.PairNotInPool.selector, TOKEN_LO, address(0xBEEF)));
        new UniswapV4TwapAnchor(key, TOKEN_LO, address(0xBEEF));
    }

    function test_priceMonotonicAcrossRealisticRange() public view {
        // 1e-12 .. 1e12 raw ratio covers any token pair with <= 24 decimals of difference.
        assertGt(baseIs0.priceAtTick(-276_325), 0);
        assertGt(baseIs0.priceAtTick(276_324), baseIs0.priceAtTick(-276_325));
        assertLt(baseIs1.priceAtTick(276_324), baseIs1.priceAtTick(-276_325));
    }

    /// @notice An unrepresentable price must revert, never reach the quoter as 0.
    function test_consult_revertsWhenPriceRoundsToZero() public {
        observer.set(0, int56(TickMath.MIN_TICK) * 1800);
        vm.expectRevert(abi.encodeWithSelector(UniswapV4TwapAnchor.PriceOutOfRange.selector, TickMath.MIN_TICK));
        baseIs0.consult(TOKEN_LO, TOKEN_HI, 1800);
    }
}

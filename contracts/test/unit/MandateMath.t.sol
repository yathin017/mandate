// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {MandateMath} from "../../src/libraries/MandateMath.sol";

contract MandateMathTest is Test {
    uint256 internal constant BAL_IN = 4_000_000e6; // USDC
    uint256 internal constant BAL_OUT = 10_000_000e18; // LAUNCH

    // ---------------------------------------------------------------- pricing

    function test_exactIn_zeroSpreadMatchesXyc() public pure {
        (uint256 out, uint256 fee) = MandateMath.amountOutForExactIn(BAL_IN, BAL_OUT, 1000e6, 0);
        assertEq(fee, 0);
        assertEq(out, 1000e6 * BAL_OUT / (BAL_IN + 1000e6));
    }

    function test_exactIn_spreadDeductedFromInput() public pure {
        (uint256 out, uint256 fee) = MandateMath.amountOutForExactIn(BAL_IN, BAL_OUT, 1000e6, 30);
        assertEq(fee, 3e6); // 0.30% of 1000 USDC
        assertEq(out, 997e6 * BAL_OUT / (BAL_IN + 997e6));
    }

    function test_exactOut_revertsWhenDrainingPool() public {
        vm.expectRevert(abi.encodeWithSelector(MandateMath.InsufficientLiquidity.selector, BAL_OUT, BAL_OUT));
        this.exactOut(BAL_IN, BAL_OUT, BAL_OUT, 30);
    }

    function test_spreadOfFullBpsReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MandateMath.InvalidSpread.selector, 10_000));
        this.exactIn(BAL_IN, BAL_OUT, 1e6, 10_000);
    }

    function test_zeroBalanceReverts() public {
        vm.expectRevert(abi.encodeWithSelector(MandateMath.ZeroBalance.selector, 0, BAL_OUT));
        this.exactIn(0, BAL_OUT, 1e6, 0);
    }

    /// @notice Exact-out never undercharges: swapping the returned input exact-in yields >= the asked output.
    function testFuzz_exactOutCoversExactIn(uint256 amountOut, uint16 spread) public pure {
        amountOut = bound(amountOut, 1, BAL_OUT / 2);
        spread = uint16(bound(spread, 0, 500));
        (uint256 amountIn, uint256 feeOut) = MandateMath.amountInForExactOut(BAL_IN, BAL_OUT, amountOut, spread);
        (uint256 outAgain, uint256 feeIn) = MandateMath.amountOutForExactIn(BAL_IN, BAL_OUT, amountIn, spread);
        assertGe(outAgain, amountOut, "exact-out undercharged");
        assertEq(feeOut, feeIn, "fee must not depend on swap mode");
    }

    /// @notice A round trip never profits the taker (no rounding leak from the treasury).
    function testFuzz_roundTripNeverProfits(uint256 amountIn, uint16 spread) public pure {
        amountIn = bound(amountIn, 1, BAL_IN);
        spread = uint16(bound(spread, 0, 500));
        (uint256 out,) = MandateMath.amountOutForExactIn(BAL_IN, BAL_OUT, amountIn, spread);
        vm.assume(out > 0);
        (uint256 back,) = MandateMath.amountOutForExactIn(BAL_OUT - out, BAL_IN + amountIn, out, spread);
        assertLe(back, amountIn);
    }

    function test_price_decimalAgnostic() public pure {
        // 0.40 USDC (6 dp) per LAUNCH (18 dp)
        assertEq(MandateMath.price(1e18, 0.4e6), 0.4e6 * 1e36 / 1e18);
        assertEq(MandateMath.price(1e18, 0.4e6), 4e23);
    }

    function test_deviationBps_roundsUp() public pure {
        assertEq(MandateMath.deviationBps(103, 100), 300);
        assertEq(MandateMath.deviationBps(97, 100), 300);
        assertEq(MandateMath.deviationBps(100_001, 100_000), 1); // 0.1 bps -> 1
        assertEq(MandateMath.deviationBps(100, 100), 0);
    }

    // ---------------------------------------------------------------- schedule

    function test_released_linear() public pure {
        uint256 start = 1000;
        uint256 dur = 180 days;
        assertEq(MandateMath.released(10_000_000e18, start, dur, start - 1), 0);
        assertEq(MandateMath.released(10_000_000e18, start, dur, start), 0);
        assertEq(MandateMath.released(10_000_000e18, start, dur, start + 90 days), 5_000_000e18);
        assertEq(MandateMath.released(10_000_000e18, start, dur, start + dur), 10_000_000e18);
        assertEq(MandateMath.released(10_000_000e18, start, dur, start + 10 * dur), 10_000_000e18);
    }

    function test_released_zeroDurationUnlocksAtStart() public pure {
        assertEq(MandateMath.released(5, 100, 0, 99), 0);
        assertEq(MandateMath.released(5, 100, 0, 100), 5);
    }

    function test_epochIndexAndEnd() public pure {
        assertEq(MandateMath.epochIndex(1000, 1 days, 0), 0);
        assertEq(MandateMath.epochIndex(1000, 1 days, 1000 + 1 days - 1), 0);
        assertEq(MandateMath.epochIndex(1000, 1 days, 1000 + 1 days), 1);
        assertEq(MandateMath.epochEnd(1000, 1 days, 1), 1000 + 2 days);
    }

    function test_epochLengthZeroReverts() public {
        vm.expectRevert(MandateMath.InvalidEpochLength.selector);
        this.epochIndex(0, 0, 1);
    }

    // ---------------------------------------------------------------- external wrappers for expectRevert

    function exactIn(uint256 bi, uint256 bo, uint256 a, uint256 s) external pure returns (uint256, uint256) {
        return MandateMath.amountOutForExactIn(bi, bo, a, s);
    }

    function exactOut(uint256 bi, uint256 bo, uint256 a, uint256 s) external pure returns (uint256, uint256) {
        return MandateMath.amountInForExactOut(bi, bo, a, s);
    }

    function epochIndex(uint256 s, uint256 l, uint256 t) external pure returns (uint256) {
        return MandateMath.epochIndex(s, l, t);
    }
}

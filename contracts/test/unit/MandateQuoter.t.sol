// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { IMandateRegistry } from "../../src/interfaces/IMandateRegistry.sol";
import { Mandate, MandateStatus } from "../../src/libraries/MandateTypes.sol";
import { MandateMath } from "../../src/libraries/MandateMath.sol";
import { MandateQuoter } from "../../src/quoter/MandateQuoter.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { MockMandateRegistry } from "../utils/MockMandateRegistry.sol";
import { MockPriceAnchor } from "../utils/MockPriceAnchor.sol";

/// @notice Rule-by-rule tests calling the quoter directly as the router would. Balances are fixed in the
///         registers, so price impact never interferes with the rule under test.
contract MandateQuoterTest is Test {
    bytes32 internal constant ID = keccak256("mandate-1");
    bytes32 internal constant STRATEGY = keccak256("strategy-1");
    uint256 internal constant T0 = 1_800_000_000;

    // Deep balances: 1B LAUNCH / 400M USDC (spot 0.40), so test-sized fills move price < 0.1%.
    uint256 internal constant BAL_BASE = 1_000_000_000e18;
    uint256 internal constant BAL_QUOTE = 400_000_000e6;

    address internal router = makeAddr("router");
    address internal safe = makeAddr("safe");
    address internal mm = makeAddr("mm");
    address internal taker = makeAddr("taker");
    address internal base = makeAddr("LAUNCH");
    address internal quote = makeAddr("USDC");

    MockMandateRegistry internal registry;
    MockPriceAnchor internal anchor;
    MandateQuoter internal quoter;

    function setUp() public {
        vm.warp(T0);
        registry = new MockMandateRegistry();
        anchor = new MockPriceAnchor();
        anchor.setPrice(MandateFixture.SPOT_X36);
        quoter = new MandateQuoter(router, IAqua(makeAddr("aqua")), IMandateRegistry(address(registry)));

        // Day 20 of 180: 1,111,111 LAUNCH released.
        Mandate memory m = MandateFixture.defaultMandate(
            safe, mm, base, quote, address(anchor), address(quoter), uint64(T0 - 20 days)
        );
        m.activeStrategyHash = STRATEGY;
        registry.set(ID, m);
    }

    // ---------------------------------------------------------------- happy path

    function test_sell_exactOut_fillsAndUpdatesCounters() public {
        uint256 out = 100_000e18;
        (uint256 expectedIn, uint256 expectedFee) =
            MandateMath.amountInForExactOut(BAL_QUOTE, BAL_BASE, out, MandateFixture.SPREAD_BPS);

        vm.expectEmit(address(quoter));
        emit IMandateQuoter.FeeAccrued(ID, quote, expectedFee);
        SwapRegisters memory r = _swap(_sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, out));

        assertEq(r.amountIn, expectedIn, "amountIn");
        assertEq(r.amountOut, out, "amountOut untouched");
        (, uint256 net, uint256 total) = quoter.epochState(ID);
        assertEq(net, out);
        assertEq(total, out);
        (uint256 baseFees, uint256 quoteFees) = quoter.feesAccrued(ID);
        assertEq(baseFees, 0);
        assertEq(quoteFees, expectedFee);
    }

    function test_sell_exactIn_matchesMath() public {
        uint256 amountIn = 10_000e6;
        (uint256 expectedOut,) =
            MandateMath.amountOutForExactIn(BAL_QUOTE, BAL_BASE, amountIn, MandateFixture.SPREAD_BPS);
        SwapRegisters memory r = _swap(_sellQuery(true), _regs(BAL_QUOTE, BAL_BASE, amountIn, 0));
        assertEq(r.amountOut, expectedOut);
    }

    function test_quotePath_matchesSwapPath_andWritesNothing() public {
        SwapRegisters memory regs = _regs(BAL_QUOTE, BAL_BASE, 0, 50_000e18);

        // Anyone may call the static path; it must not write.
        vm.prank(taker);
        (,, SwapRegisters memory q) = quoter.extruction(true, 0, _sellQuery(false), regs, _args(), "");
        (, uint256 net,) = quoter.epochState(ID);
        assertEq(net, 0, "quote wrote state");

        SwapRegisters memory s = _swap(_sellQuery(false), regs);
        assertEq(q.amountIn, s.amountIn, "quote != swap");
    }

    function test_buyback_reducesCounters_neverBelowZero() public {
        _swap(_sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 100_000e18));

        // Taker sells 40k LAUNCH to the treasury.
        _swap(_buyQuery(true), _regs(BAL_BASE, BAL_QUOTE, 40_000e18, 0));
        (, uint256 net, uint256 total) = quoter.epochState(ID);
        assertEq(net, 60_000e18);
        assertEq(total, 60_000e18);
        (uint256 baseFees,) = quoter.feesAccrued(ID);
        assertEq(baseFees, MandateMath.feeOf(40_000e18, MandateFixture.SPREAD_BPS), "buyback fee in base");

        // A buyback larger than what was sold clamps at zero.
        _swap(_buyQuery(true), _regs(BAL_BASE, BAL_QUOTE, 100_000e18, 0));
        (, net, total) = quoter.epochState(ID);
        assertEq(net, 0);
        assertEq(total, 0);
    }

    // ---------------------------------------------------------------- caller / identity

    function test_revert_notRouter() public {
        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.NotRouter.selector, taker));
        quoter.extruction(false, 0, _sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 1e18), _args(), "");
    }

    function test_revert_invalidArgs() public {
        vm.prank(router);
        vm.expectRevert(IMandateQuoter.InvalidArgs.selector);
        quoter.extruction(false, 0, _sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 1e18), hex"01", "");
    }

    function test_revert_mandateNotFound() public {
        bytes32 unknown = keccak256("nope");
        vm.prank(router);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.MandateNotFound.selector, unknown));
        quoter.extruction(
            false, 0, _sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 1e18), abi.encodePacked(unknown), ""
        );
    }

    /// @notice Griefing guard: a stranger's strategy pointing at our mandate id is refused.
    function test_revert_wrongMaker() public {
        SwapQuery memory q = _sellQuery(false);
        q.maker = taker;
        _expectSwapRevert(
            q,
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.WrongMaker.selector, taker, safe)
        );
    }

    function test_revert_inactiveStrategy() public {
        SwapQuery memory q = _sellQuery(false);
        q.orderHash = keccak256("old-strategy");
        _expectSwapRevert(
            q,
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.InactiveStrategy.selector, q.orderHash, STRATEGY)
        );
    }

    function test_revert_wrongPair() public {
        SwapQuery memory q = _sellQuery(false);
        q.tokenIn = makeAddr("WETH");
        _expectSwapRevert(
            q,
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.WrongPair.selector, q.tokenIn, base)
        );
    }

    function test_revert_amountAlreadyComputed() public {
        _expectSwapRevert(
            _sellQuery(true),
            _regs(BAL_QUOTE, BAL_BASE, 1e6, 1),
            abi.encodeWithSelector(IMandateQuoter.AmountAlreadyComputed.selector)
        );
    }

    // ---------------------------------------------------------------- rules

    function test_revert_revoked() public {
        registry.setStatus(ID, MandateStatus.Revoked);
        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.MandateRevoked.selector)
        );
    }

    function test_revert_paused() public {
        registry.setStatus(ID, MandateStatus.Paused);
        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.MandatePaused.selector)
        );
    }

    function test_revert_anchorDeviation_bothDirections() public {
        // Anchor says 0.36: a sell near 0.40 is >3% away.
        anchor.setPrice(3.6e23);
        vm.prank(router);
        vm.expectPartialRevert(IMandateQuoter.AnchorDeviation.selector);
        quoter.extruction(false, 0, _sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 1e18), _args(), "");

        // Anchor says 0.44: a buyback near 0.40 is >3% away.
        anchor.setPrice(4.4e23);
        vm.prank(router);
        vm.expectPartialRevert(IMandateQuoter.AnchorDeviation.selector);
        quoter.extruction(false, 0, _buyQuery(true), _regs(BAL_BASE, BAL_QUOTE, 1e18, 0), _args(), "");
    }

    function test_revert_anchorUnavailable_blocksTrading() public {
        anchor.setBroken(true);
        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(MockPriceAnchor.AnchorUnavailable.selector)
        );
    }

    function test_revert_belowFloor() public {
        // Pool and anchor both at 0.25, under the 0.30 floor.
        anchor.setPrice(2.5e23);
        vm.prank(router);
        vm.expectPartialRevert(IMandateQuoter.BelowFloor.selector);
        quoter.extruction(false, 0, _sellQuery(false), _regs(250_000_000e6, BAL_BASE, 0, 1e18), _args(), "");
    }

    function test_floorDoesNotApplyToBuybacks() public {
        anchor.setPrice(2.5e23);
        _swap(_buyQuery(true), _regs(BAL_BASE, 250_000_000e6, 1000e18, 0));
    }

    function test_epochCap_blocksThenResetsNextEpoch() public {
        _swap(_sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 150_000e18));
        assertEq(quoter.remainingThisEpoch(ID), 50_000e18);

        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 60_000e18),
            abi.encodeWithSelector(IMandateQuoter.EpochCapReached.selector, 150_000e18, 60_000e18, 200_000e18)
        );

        vm.warp(quoter.epochResetsAt(ID));
        assertEq(quoter.remainingThisEpoch(ID), 200_000e18);
        _swap(_sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, 60_000e18));
    }

    function test_epochCap_clampedToIssuerMax() public {
        registry.setEpochCap(ID, 1_000_000e18); // MM value above the 200k bound
        assertEq(quoter.remainingThisEpoch(ID), 200_000e18);
        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 200_001e18),
            abi.encodeWithSelector(IMandateQuoter.EpochCapReached.selector, 0, 200_001e18, 200_000e18)
        );
    }

    function test_releaseExceeded() public {
        // Day 1: 55,555 LAUNCH released, well under the 200k epoch cap.
        Mandate memory m = registry.getMandate(ID);
        m.bounds.releaseStart = uint64(T0 - 1 days);
        registry.set(ID, m);
        uint256 unlocked = quoter.released(ID);
        assertEq(unlocked, MandateFixture.ALLOTMENT / 180);
        assertEq(quoter.sellableNow(ID), unlocked);

        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, unlocked + 1),
            abi.encodeWithSelector(IMandateQuoter.ReleaseExceeded.selector, 0, unlocked + 1, unlocked)
        );
        _swap(_sellQuery(false), _regs(BAL_QUOTE, BAL_BASE, 0, unlocked));
    }

    function test_nothingSellableBeforeReleaseStart() public {
        Mandate memory m = registry.getMandate(ID);
        m.bounds.releaseStart = uint64(T0 + 1 days);
        registry.set(ID, m);
        assertEq(quoter.sellableNow(ID), 0);
        _expectSwapRevert(
            _sellQuery(false),
            _regs(BAL_QUOTE, BAL_BASE, 0, 1e18),
            abi.encodeWithSelector(IMandateQuoter.ReleaseExceeded.selector, 0, 1e18, 0)
        );
    }

    // ---------------------------------------------------------------- helpers

    function _args() internal pure returns (bytes memory) {
        return abi.encodePacked(ID);
    }

    /// @dev Treasury sells base: taker pays quote, receives base.
    function _sellQuery(bool isExactIn) internal view returns (SwapQuery memory) {
        return SwapQuery({
            orderHash: STRATEGY, maker: safe, taker: taker, tokenIn: quote, tokenOut: base, isExactIn: isExactIn
        });
    }

    /// @dev Treasury buys base back: taker pays base, receives quote.
    function _buyQuery(bool isExactIn) internal view returns (SwapQuery memory) {
        return SwapQuery({
            orderHash: STRATEGY, maker: safe, taker: taker, tokenIn: base, tokenOut: quote, isExactIn: isExactIn
        });
    }

    function _regs(
        uint256 balanceIn,
        uint256 balanceOut,
        uint256 amountIn,
        uint256 amountOut
    )
        internal
        pure
        returns (SwapRegisters memory)
    {
        return SwapRegisters({
            balanceIn: balanceIn, balanceOut: balanceOut, amountIn: amountIn, amountOut: amountOut, amountNetPulled: 0
        });
    }

    function _swap(SwapQuery memory q, SwapRegisters memory regs) internal returns (SwapRegisters memory r) {
        vm.prank(router);
        (,, r) = quoter.extruction(false, 0, q, regs, _args(), "");
    }

    function _expectSwapRevert(SwapQuery memory q, SwapRegisters memory regs, bytes memory err) internal {
        vm.prank(router);
        vm.expectRevert(err);
        quoter.extruction(false, 0, q, regs, _args(), "");
    }
}

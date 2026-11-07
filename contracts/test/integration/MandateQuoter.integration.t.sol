// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { MandateMath } from "../../src/libraries/MandateMath.sol";
import { PolicyConfig, RiskMode, RiskReason, Status, Strategy, StrategyKind } from "../../src/libraries/MandateTypes.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { MandateVenueSetup } from "../utils/MandateVenueSetup.sol";

/// @title MandateQuoterIntegrationTest
/// @notice MandateQuoter behind real Aqua + AquaSwapVMRouter bytecode (pinned swap-vm v1.0.2, as on mainnet), with a
///         settable registry and market oracle. Covers every rule, and one test per loophole the v2 design closes.
///         Numbers are test inputs (MandateFixture), not recommendations.
contract MandateQuoterIntegrationTest is MandateVenueSetup {
    uint256 internal constant FILL = 100_000e18;

    function _venue() internal override returns (IAqua, ISwapVM) {
        Aqua a = new Aqua();
        AquaSwapVMRouter r = new AquaSwapVMRouter(address(a), address(0), address(this), "1inch SwapVM v1.0", "1.0.2");
        return (IAqua(address(a)), ISwapVM(address(r)));
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        _setUpPolicy();
    }

    // ---------------------------------------------------------------- helpers

    function _config() internal view returns (PolicyConfig memory) {
        return registry.getPolicy(POLICY_ID).config;
    }

    /// @dev Points the oracle's flat market at the strategy's current pre-trade price, so price drift from earlier
    ///      fills does not hide the rule under test.
    function _syncOracle(bytes32 hash) internal {
        (uint256 base, uint256 quote) = aqua.safeBalances(safe, address(router), hash, address(launch), address(usdc));
        oracle.setFlat(MandateMath.price(base, quote), DEEP);
    }

    function _counters() internal view returns (IMandateQuoter.PolicyCounters memory) {
        return quoter.policyCounters(POLICY_ID);
    }

    // ---------------------------------------------------------------- happy paths

    function test_sell_movesRealTokensAndCountsGrossNetAndRelease() public {
        uint256 usdcIn = _buyLaunch(order, FILL);
        assertEq(launch.balanceOf(safe), 10 * SHIP_LAUNCH - FILL);
        assertEq(usdc.balanceOf(safe), 10 * SHIP_USDC + usdcIn);
        IMandateQuoter.PolicyCounters memory c = _counters();
        assertEq(c.grossSold, FILL);
        assertEq(c.netSold, FILL);
        assertEq(c.totalNetSold, FILL);
        assertEq(c.quoteSpent, 0);
        (, uint256 quoteFees) = quoter.feesAccrued(STRATEGY_ID);
        assertEq(quoteFees, MandateMath.feeOf(usdcIn, MandateFixture.SPREAD_BPS));
    }

    function test_buy_spendsQuoteBudgetAndRestoresNetButNotGross() public {
        _buyLaunch(order, FILL);
        _syncOracle(strategyHash);
        uint256 usdcOut = _sellLaunch(order, FILL);
        IMandateQuoter.PolicyCounters memory c = _counters();
        assertEq(c.grossSold, FILL, "gross never goes down");
        assertEq(c.netSold, 0);
        assertEq(c.totalNetSold, 0);
        assertEq(c.quoteSpent, usdcOut);
    }

    function test_quoteEqualsSwap() public {
        (uint256 quotedIn,) = taker.quote(order, address(usdc), address(launch), 12_345e18, false);
        uint256 paid = _buyLaunch(order, 12_345e18);
        assertEq(paid, quotedIn);
    }

    // ---------------------------------------------------------------- loophole 2: buybacks reset sell capacity

    function test_loophole_roundTripsCannotExceedTheGrossCap() public {
        // Sell, buy back, sell, buy back, sell: net stays at one fill, gross reaches three.
        for (uint256 i; i < 3; ++i) {
            _syncOracle(strategyHash);
            _buyLaunch(order, FILL);
            if (i < 2) {
                _syncOracle(strategyHash);
                _sellLaunch(order, FILL);
            }
        }
        IMandateQuoter.PolicyCounters memory c = _counters();
        assertEq(c.grossSold, 3 * FILL);
        assertEq(c.netSold, FILL);
        _syncOracle(strategyHash);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.GrossSellCapReached.selector, 3 * FILL, 1e18, MandateFixture.GROSS_CAP));
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    // ---------------------------------------------------------------- loophole 4: several strategies, one budget

    function test_loophole_strategiesShareOnePolicyBudget() public {
        bytes32 second = keccak256("strategy-2");
        (ISwapVM.Order memory order2, bytes32 hash2) = _addStrategy(second, StrategyKind.MarketMaking, 0, SHIP_LAUNCH, SHIP_USDC);
        _buyLaunch(order, FILL);
        _syncOracle(hash2);
        _buyLaunch(order2, FILL);
        assertEq(_counters().netSold, 2 * FILL, "both strategies draw on one net cap");

        // Each strategy alone is far from the cap, but the policy is at it.
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.NetSellCapReached.selector, 2 * FILL, 1e18, MandateFixture.NET_CAP));
        taker.swap(order2, address(usdc), address(launch), 1e18, false);
    }

    // ---------------------------------------------------------------- loophole 3: reship resets accounting

    function test_loophole_newStrategyVersionKeepsCounters() public {
        _buyLaunch(order, FILL);
        (ISwapVM.Order memory v2, bytes32 v2Hash) = _shipFrom(safe, STRATEGY_ID, 2, SHIP_LAUNCH, SHIP_USDC);
        registry.setActiveStrategy(STRATEGY_ID, v2Hash);

        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.InactiveStrategy.selector, strategyHash, v2Hash));
        taker.swap(order, address(usdc), address(launch), 1e18, false);

        _buyLaunch(v2, FILL);
        assertEq(_counters().netSold, 2 * FILL, "the new version continues the policy's counters");
    }

    // ---------------------------------------------------------------- sell rules

    function test_release_limitsLifetimeNetSales() public {
        PolicyConfig memory c = _config();
        c.release.allotment = 1_000_000e18; // day 20 of 180: ~111k unlocked
        registry.setConfig(POLICY_ID, c);
        _buyLaunch(order, FILL);
        uint256 unlocked = _counters().released;
        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.ReleaseExceeded.selector, FILL, 20_000e18, unlocked));
        taker.swap(order, address(usdc), address(launch), 20_000e18, false);
    }

    function test_floor_refusesSellsBelowIt() public {
        PolicyConfig memory c = _config();
        c.price.floorPriceX36 = 5e23; // above the 0.40 market
        registry.setConfig(POLICY_ID, c);
        usdc.mint(address(taker), 1e6);
        vm.expectPartialRevert(IMandateQuoter.BelowFloor.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_periodRollover_resetsPeriodCountersOnly() public {
        _buyLaunch(order, FILL);
        _syncOracle(strategyHash);
        _sellLaunch(order, FILL / 2);
        vm.warp(block.timestamp + 1 days);
        IMandateQuoter.PolicyCounters memory c = _counters();
        assertEq(c.grossSold, 0);
        assertEq(c.netSold, 0);
        assertEq(c.quoteSpent, 0);
        assertEq(c.totalNetSold, FILL / 2, "lifetime net carries over");
    }

    // ---------------------------------------------------------------- price checks (loophole 8)

    function test_preTradePrice_mustBeNearTheTwap() public {
        oracle.setFlat(45e22, DEEP); // market at 0.45, strategy quoting from 0.40: 11% off
        usdc.mint(address(taker), 1e6);
        vm.expectPartialRevert(IMandateQuoter.QuoteOffMarket.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_impact_beyondSpreadPlusAllowanceIsRefused() public {
        // 600k of a 10M curve moves the price ~6%: more than 0.3% spread + 3% allowance.
        PolicyConfig memory c = _config();
        c.normal.maxFillBase = 1_000_000e18;
        registry.setConfig(POLICY_ID, c);
        usdc.mint(address(taker), 1_000_000e6);
        vm.expectPartialRevert(IMandateQuoter.PriceImpactTooHigh.selector);
        taker.swap(order, address(usdc), address(launch), 600_000e18, false);
    }

    function test_largeLegitimateFill_passesWhenWithinImpact() public {
        // A 2.5% move on a large fill is ordinary impact, not an off-market quote.
        PolicyConfig memory c = _config();
        c.normal.maxFillBase = 1_000_000e18;
        registry.setConfig(POLICY_ID, c);
        _buyLaunch(order, 120_000e18);
    }

    // ---------------------------------------------------------------- size caps (loophole 1)

    function test_fillSize_isCappedByTrustedDepth() public {
        oracle.setFlat(MandateFixture.SPOT_X36, 100_000e18); // normal: 50% of depth = 50k
        // Depth 100k is below the defensive threshold, so the defensive limits (20% of depth) apply.
        usdc.mint(address(taker), 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.FillTooLarge.selector, 60_000e18, 20_000e18));
        taker.swap(order, address(usdc), address(launch), 60_000e18, false);
    }

    function test_fillSize_isCappedAbsolutely() public {
        usdc.mint(address(taker), 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.FillTooLarge.selector, 110_000e18, MandateFixture.NORMAL_MAX_FILL));
        taker.swap(order, address(usdc), address(launch), 110_000e18, false);
    }

    // ---------------------------------------------------------------- risk modes (loopholes 1, 5, 6, 9)

    function test_unpricedOracle_pauses() public {
        oracle.setPriced(false);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.Unpriced));
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_youngPool_pauses() public {
        oracle.setPoolAge(10 minutes);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.PoolTooYoung));
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_thinPool_pauses() public {
        oracle.setDepth(10_000e18);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.DepthBelowMinimum));
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_largeMove_pausesButModerateMoveOnlyDefends() public {
        oracle.setSpot(48e22); // 20% above the TWAP
        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.MoveBeyondPause));
        taker.swap(order, address(usdc), address(launch), 1e18, false);

        oracle.setSpot(412e21); // 3%: defensive, trading continues within tighter limits
        (RiskMode mode, RiskReason reason,) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Defensive));
        assertEq(uint8(reason), uint8(RiskReason.MoveDefensive));
        _buyLaunch(order, 10_000e18);
    }

    function test_defensive_raisesSpreadShrinksFillsAndStopsBuys() public {
        oracle.setShortTwap(413e21); // 3.25% volatility: beyond the 3% defensive threshold
        uint256 usdcIn = _buyLaunch(order, 10_000e18);
        (, uint256 quoteFees) = quoter.feesAccrued(STRATEGY_ID);
        assertEq(quoteFees, MandateMath.feeOf(usdcIn, MandateFixture.DEFENSIVE_MIN_SPREAD), "the mode's minimum spread applied");

        usdc.mint(address(taker), 100_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.FillTooLarge.selector, 30_000e18, MandateFixture.DEFENSIVE_MAX_FILL));
        taker.swap(order, address(usdc), address(launch), 30_000e18, false);

        launch.mint(address(taker), 1e18);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.BuybacksNotAllowed.selector, RiskMode.Defensive));
        taker.swap(order, address(launch), address(usdc), 1e18, true);
    }

    // ---------------------------------------------------------------- buys

    function test_quoteSpendCap_bindsAllBuys() public {
        PolicyConfig memory c = _config();
        c.period.quoteSpendCap = 50_000e6; // ~one 100k buy at 0.40 is 40k
        registry.setConfig(POLICY_ID, c);
        uint256 spent = _sellLaunch(order, FILL);
        _syncOracle(strategyHash);
        launch.mint(address(taker), 50_000e18);
        vm.expectPartialRevert(IMandateQuoter.QuoteSpendCapReached.selector);
        taker.swap(order, address(launch), address(usdc), 50_000e18, true);
        assertEq(_counters().quoteSpent, spent);
    }

    function test_buybackStrategy_onlyBuysAtOrBelowItsPrice() public {
        bytes32 bb = keccak256("buyback");
        (ISwapVM.Order memory bbOrder,) = _addStrategy(bb, StrategyKind.Buyback, 39e22, SHIP_LAUNCH, SHIP_USDC);

        usdc.mint(address(taker), 1e6);
        vm.expectRevert(IMandateQuoter.SellsNotAllowed.selector);
        taker.swap(bbOrder, address(usdc), address(launch), 1e18, false);

        // At ~0.40 less spread the buy price is above 0.39.
        launch.mint(address(taker), 1e18);
        vm.expectPartialRevert(IMandateQuoter.AboveMaxBuyPrice.selector);
        taker.swap(bbOrder, address(launch), address(usdc), 1e18, true);

        registry.setStrategy(bb, _withMaxBuy(bb, 41e22));
        uint256 usdcOut = _sellLaunch(bbOrder, 1000e18);
        assertEq(_counters().quoteSpent, usdcOut);
    }

    function _withMaxBuy(bytes32 id, uint256 maxBuy) internal view returns (Strategy memory s) {
        s = registry.getStrategy(id);
        s.bounds.maxBuyPriceX36 = maxBuy;
    }

    // ---------------------------------------------------------------- statuses and identity

    function test_statuses_policyFirstThenStrategy() public {
        usdc.mint(address(taker), 1e6);
        registry.setStrategyStatus(STRATEGY_ID, Status.Paused);
        registry.setPolicyStatus(POLICY_ID, Status.Revoked);
        vm.expectRevert(IMandateQuoter.PolicyRevoked.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);

        registry.setPolicyStatus(POLICY_ID, Status.Paused);
        vm.expectRevert(IMandateQuoter.PolicyPaused.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);

        registry.setPolicyStatus(POLICY_ID, Status.Active);
        vm.expectRevert(IMandateQuoter.StrategyPaused.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);

        registry.setStrategyStatus(STRATEGY_ID, Status.Revoked);
        vm.expectRevert(IMandateQuoter.StrategyRevoked.selector);
        taker.swap(order, address(usdc), address(launch), 1e18, false);
    }

    function test_identity_otherMakersCannotUseTheStrategy() public {
        address attacker = makeAddr("attacker");
        launch.mint(attacker, SHIP_LAUNCH);
        usdc.mint(attacker, SHIP_USDC);
        vm.startPrank(attacker);
        launch.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        (ISwapVM.Order memory fake,) = _shipFrom(attacker, STRATEGY_ID, 1, SHIP_LAUNCH, SHIP_USDC);
        usdc.mint(address(taker), 1e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.WrongMaker.selector, attacker, safe));
        taker.swap(fake, address(usdc), address(launch), 1e18, false);
    }

    function test_directStatefulCall_reverts() public {
        SwapQuery memory q = SwapQuery({
            orderHash: strategyHash, maker: safe, taker: address(this), tokenIn: address(usdc), tokenOut: address(launch), isExactIn: true
        });
        SwapRegisters memory regs =
            SwapRegisters({ balanceIn: SHIP_USDC, balanceOut: SHIP_LAUNCH, amountIn: 1e6, amountOut: 0, amountNetPulled: 0 });
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.NotRouter.selector, address(this)));
        quoter.extruction(false, 0, q, regs, abi.encodePacked(STRATEGY_ID), "");
    }

    function test_riskModeView_reportsTheReadings() public view {
        (RiskMode mode, RiskReason reason, IMarketOracle.Health memory h) = quoter.riskMode(POLICY_ID);
        assertEq(uint8(mode), uint8(RiskMode.Normal));
        assertEq(uint8(reason), uint8(RiskReason.None));
        assertEq(h.twapX36, MandateFixture.SPOT_X36);
    }
}

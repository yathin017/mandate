// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";

import { IMandateModule } from "../../src/interfaces/IMandateModule.sol";
import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { ISafe } from "../../src/interfaces/ISafe.sol";
import {
    Policy,
    PolicyConfig,
    Status,
    Strategy,
    StrategyBounds,
    StrategyKind,
    StrategyParams
} from "../../src/libraries/MandateTypes.sol";
import { MandateModule } from "../../src/module/MandateModule.sol";
import { MandateQuoter } from "../../src/quoter/MandateQuoter.sol";
import { AquaTaker } from "../../src/mocks/AquaTaker.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { MockMarketOracle } from "../utils/MockMarketOracle.sol";
import { MockSafe } from "../utils/MockSafe.sol";

/// @title MandateModuleIntegrationTest
/// @notice MandateModule + its quoter behind real Aqua/router bytecode (pinned v1.0.2 source), with a mock Safe and a
///         settable market oracle. Covers policy and strategy lifecycles, validation, backing, and every permission,
///         especially what a market maker must never be able to do.
contract MandateModuleIntegrationTest is Test {
    /// @dev The Safe holds exactly this much, so backing checks bind at known amounts.
    uint256 internal constant HELD_LAUNCH = 10_000_000e18;
    uint256 internal constant HELD_USDC = 4_000_000e6;
    /// @dev The first strategy ships half of each, leaving room for a second.
    uint256 internal constant SHIP_LAUNCH = 5_000_000e18;
    uint256 internal constant SHIP_USDC = 2_000_000e6;

    address internal owner = makeAddr("safeOwner");
    address internal mm = makeAddr("marketMaker");
    address internal mm2 = makeAddr("marketMaker2");
    address internal stranger = makeAddr("stranger");

    IAqua internal aqua;
    ISwapVM internal router;
    MandateModule internal module;
    MandateQuoter internal quoter;
    MockSafe internal safe;
    MockERC20 internal launch;
    MockERC20 internal usdc;
    MockMarketOracle internal oracle;
    AquaTaker internal taker;

    bytes32 internal policyId;
    bytes32 internal strategyId;

    function setUp() public {
        vm.warp(1_800_000_000);
        Aqua a = new Aqua();
        aqua = IAqua(address(a));
        router =
            ISwapVM(address(new AquaSwapVMRouter(address(a), address(0), address(this), "1inch SwapVM v1.0", "1.0.2")));
        module = new MandateModule(address(router), aqua);
        quoter = module.QUOTER();

        launch = new MockERC20("Launch Token", "LAUNCH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        oracle = new MockMarketOracle();
        oracle.setFlat(MandateFixture.SPOT_X36, 100_000_000e18);
        taker = new AquaTaker(aqua, router);

        safe = new MockSafe(owner);
        launch.mint(address(safe), HELD_LAUNCH);
        usdc.mint(address(safe), HELD_USDC);
        _asSafe(address(safe), abi.encodeCall(MockSafe.enableModule, (address(module))));

        policyId = _createPolicy(_config());
        strategyId = _addStrategy(mm, StrategyKind.MarketMaking, _mmBounds(), _params(30, SHIP_LAUNCH, SHIP_USDC));
    }

    // ================================================================ policies

    function test_createPolicy_registersAndApprovesAqua() public view {
        Policy memory p = module.getPolicy(policyId);
        assertEq(p.safe, address(safe));
        assertEq(p.base, address(launch));
        assertEq(p.quote, address(usdc));
        assertEq(uint8(p.status), uint8(Status.Active));
        assertEq(p.config.period.grossSellCap, MandateFixture.GROSS_CAP);
        assertEq(module.activePolicyOf(address(safe), address(launch)), policyId);
        assertEq(module.policiesOf(address(safe)).length, 1);
        assertEq(IERC20(address(launch)).allowance(address(safe), address(aqua)), type(uint256).max);
        assertEq(IERC20(address(usdc)).allowance(address(safe), address(aqua)), type(uint256).max);
        assertEq(address(quoter.REGISTRY()), address(module));
    }

    /// @notice Loophole 4: a second policy for the same base would double the treasury's risk budget.
    function test_createPolicy_onePerBaseToken() public {
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.PolicyAlreadyActive.selector, policyId));
        safe.execute(
            address(module), abi.encodeCall(MandateModule.createPolicy, (address(launch), address(usdc), _config()))
        );
    }

    function test_createPolicy_newOneAllowedAfterRevoke() public {
        _asSafe(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        assertEq(module.activePolicyOf(address(safe), address(launch)), bytes32(0));
        bytes32 next = _createPolicy(_config());
        assertTrue(next != policyId);
        assertEq(module.activePolicyOf(address(safe), address(launch)), next);
    }

    function test_createPolicy_requiresModuleEnabled() public {
        MockSafe other = new MockSafe(owner);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.ModuleNotEnabled.selector, address(other)));
        other.execute(
            address(module), abi.encodeCall(MandateModule.createPolicy, (address(launch), address(usdc), _config()))
        );
    }

    function test_createPolicy_rejectsSameToken() public {
        MockERC20 other = new MockERC20("Other", "OTH", 18);
        vm.prank(owner);
        vm.expectRevert(IMandateModule.InvalidParties.selector);
        safe.execute(address(module), abi.encodeCall(MandateModule.createPolicy, (address(other), address(other), _config())));
    }

    function test_policyValidation_rejectsEachInvalidField() public {
        PolicyConfig[] memory bad = new PolicyConfig[](16);
        string[] memory fields = new string[](16);
        uint256 n;

        PolicyConfig memory c = _config();
        c.release.allotment = 0;
        (bad[n], fields[n++]) = (c, "allotment");
        c = _config();
        c.release.releaseDuration = 0;
        (bad[n], fields[n++]) = (c, "releaseDuration");
        c = _config();
        c.period.periodLength = 0;
        (bad[n], fields[n++]) = (c, "periodLength");
        c = _config();
        c.period.grossSellCap = 0;
        (bad[n], fields[n++]) = (c, "grossSellCap");
        c = _config();
        c.period.netSellCap = c.period.grossSellCap + 1;
        (bad[n], fields[n++]) = (c, "netSellCap");
        c = _config();
        c.price.maxImpactBps = 10_001;
        (bad[n], fields[n++]) = (c, "maxImpactBps");
        c = _config();
        c.oracle.oracle = address(0);
        (bad[n], fields[n++]) = (c, "oracle");
        c = _config();
        c.oracle.shortWindow = c.oracle.twapWindow + 1;
        (bad[n], fields[n++]) = (c, "shortWindow");
        c = _config();
        c.oracle.depthBandBps = 0;
        (bad[n], fields[n++]) = (c, "depthBandBps");
        c = _config();
        c.oracle.defensiveMoveBps = c.oracle.pauseMoveBps + 1;
        (bad[n], fields[n++]) = (c, "defensiveMoveBps");
        c = _config();
        c.oracle.minTrustedDepth = c.oracle.defensiveDepth + 1;
        (bad[n], fields[n++]) = (c, "defensiveDepth");
        c = _config();
        c.normal.maxFillBase = 0;
        (bad[n], fields[n++]) = (c, "normal.maxFillBase");
        c = _config();
        c.defensive.maxFillDepthBps = 0;
        (bad[n], fields[n++]) = (c, "defensive.maxFillDepthBps");
        c = _config();
        c.defensive.maxFillBase = c.normal.maxFillBase + 1;
        (bad[n], fields[n++]) = (c, "defensive.maxFillBase");
        c = _config();
        c.defensive.minSpreadBps = 0;
        c.normal.minSpreadBps = 10;
        (bad[n], fields[n++]) = (c, "defensive.minSpreadBps");
        c = _config();
        c.normal.buybacksAllowed = false;
        c.defensive.buybacksAllowed = true;
        (bad[n], fields[n++]) = (c, "defensive.buybacksAllowed");

        for (uint256 i; i < n; ++i) {
            vm.prank(owner);
            vm.expectRevert(abi.encodeWithSelector(IMandateModule.InvalidPolicy.selector, fields[i]));
            safe.execute(address(module), abi.encodeCall(MandateModule.updatePolicy, (policyId, bad[i])));
        }
    }

    function test_updatePolicy_takesEffectOnTheNextFill() public {
        PolicyConfig memory c = _config();
        c.normal.maxFillBase = 1000e18;
        c.defensive.maxFillBase = 1000e18;
        _asSafe(address(module), abi.encodeCall(MandateModule.updatePolicy, (policyId, c)));
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.FillTooLarge.selector, 2000e18, 1000e18), 2000e18);
    }

    function test_pausePolicy_blocksEveryStrategyUntilUnpaused() public {
        bytes32 second = _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1000e18, 400e6));
        _asSafe(address(module), abi.encodeCall(MandateModule.pausePolicy, (policyId)));
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.PolicyPaused.selector), 1000e18);
        _expectBuyRevertOn(second, abi.encodeWithSelector(IMandateQuoter.PolicyPaused.selector), 10e18);

        _asSafe(address(module), abi.encodeCall(MandateModule.unpausePolicy, (policyId)));
        _buy(strategyId, 1000e18);
    }

    function test_revokePolicy_revokesAndDocksEveryStrategy() public {
        bytes32 second = _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1000e18, 400e6));
        _asSafe(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));

        assertEq(uint8(module.getPolicy(policyId).status), uint8(Status.Revoked));
        assertEq(uint8(module.getStrategy(strategyId).status), uint8(Status.Revoked));
        assertEq(uint8(module.getStrategy(second).status), uint8(Status.Revoked));
        assertEq(module.liveStrategiesOf(address(safe)).length, 0);
        (uint248 b,) = aqua.rawBalances(address(safe), address(router), module.getStrategy(strategyId).activeStrategyHash, address(launch));
        assertEq(b, 0, "docked");

        vm.prank(owner);
        vm.expectRevert(IMandateModule.NotPaused.selector);
        safe.execute(address(module), abi.encodeCall(MandateModule.unpausePolicy, (policyId)));
        vm.prank(owner);
        vm.expectRevert(IMandateModule.IsRevoked.selector);
        safe.execute(address(module), abi.encodeCall(MandateModule.updatePolicy, (policyId, _config())));
        vm.prank(owner);
        vm.expectRevert(IMandateModule.PolicyNotActive.selector);
        safe.execute(
            address(module),
            abi.encodeCall(
                MandateModule.addStrategy,
                (policyId, mm, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1000e18, 400e6))
            )
        );
    }

    /// @notice Even with the module disabled, revoke succeeds and the quoter refuses every fill.
    function test_revokePolicy_cannotBeBlocked() public {
        _asSafe(address(safe), abi.encodeCall(MockSafe.disableModule, (address(module))));
        vm.expectEmit(address(module));
        emit IMandateModule.StrategyRevoked(strategyId, false);
        _asSafe(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.PolicyRevoked.selector), 1000e18);
    }

    // ================================================================ strategies

    function test_addStrategy_shipsAndRegisters() public view {
        Strategy memory s = module.getStrategy(strategyId);
        assertEq(s.policyId, policyId);
        assertEq(s.mm, mm);
        assertEq(uint8(s.kind), uint8(StrategyKind.MarketMaking));
        assertEq(uint8(s.status), uint8(Status.Active));
        assertEq(s.activeStrategyHash, router.hash(module.activeOrder(strategyId)));
        (uint256 b, uint256 q) =
            aqua.safeBalances(address(safe), address(router), s.activeStrategyHash, address(launch), address(usdc));
        assertEq(b, SHIP_LAUNCH);
        assertEq(q, SHIP_USDC);
        assertEq(module.strategiesOf(policyId).length, 1);
        assertEq(module.liveStrategiesOf(address(safe)).length, 1);
    }

    function test_addStrategy_kindMustMatchBounds() public {
        StrategyBounds memory b = _mmBounds();
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.InvalidStrategy.selector, "maxBuyPriceX36"));
        safe.execute(
            address(module),
            abi.encodeCall(MandateModule.addStrategy, (policyId, mm2, StrategyKind.Buyback, b, _params(30, 1e18, 1e6)))
        );
        b.maxBuyPriceX36 = 1;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.InvalidStrategy.selector, "maxBuyPriceX36"));
        safe.execute(
            address(module),
            abi.encodeCall(MandateModule.addStrategy, (policyId, mm2, StrategyKind.MarketMaking, b, _params(30, 1e18, 1e6)))
        );
    }

    function test_addStrategy_rejectsSafeAsMarketMaker() public {
        vm.prank(owner);
        vm.expectRevert(IMandateModule.InvalidParties.selector);
        safe.execute(
            address(module),
            abi.encodeCall(
                MandateModule.addStrategy,
                (policyId, address(safe), StrategyKind.MarketMaking, _mmBounds(), _params(30, 1e18, 1e6))
            )
        );
    }

    function test_addStrategy_capsTheNumberOfLiveStrategies() public {
        uint256 limit = module.MAX_LIVE_STRATEGIES_PER_SAFE();
        for (uint256 i = 1; i < limit; ++i) {
            _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1e18, 1e6));
        }
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.TooManyStrategies.selector, limit));
        safe.execute(
            address(module),
            abi.encodeCall(MandateModule.addStrategy, (policyId, mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1e18, 1e6)))
        );
    }

    /// @notice Loophole 7: Aqua balances are virtual, so strategies could promise the same tokens twice.
    function test_backing_strategiesCannotOvercommitTheSafe() public {
        uint256 room = HELD_LAUNCH - SHIP_LAUNCH;
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateModule.InsufficientBacking.selector, address(launch), HELD_LAUNCH + 1, HELD_LAUNCH)
        );
        safe.execute(
            address(module),
            abi.encodeCall(
                MandateModule.addStrategy,
                (policyId, mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, room + 1, 1e6))
            )
        );
        _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, room, 1e6));
    }

    function test_backing_countsTokensAlreadySold() public {
        // Fill both strategies to the brim, then sell some base: a reship cannot restore the sold amount.
        _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, HELD_LAUNCH - SHIP_LAUNCH, 1e6));
        _buy(strategyId, 40_000e18);
        vm.prank(mm);
        vm.expectRevert(
            abi.encodeWithSelector(IMandateModule.InsufficientBacking.selector, address(launch), HELD_LAUNCH, HELD_LAUNCH - 40_000e18)
        );
        module.reship(strategyId, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.prank(mm);
        module.reship(strategyId, _params(30, SHIP_LAUNCH - 40_000e18, SHIP_USDC));
    }

    function test_backing_revokedStrategiesFreeTheirCommitment() public {
        bytes32 second = _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, HELD_LAUNCH - SHIP_LAUNCH, 1e6));
        _asSafe(address(module), abi.encodeCall(MandateModule.revokeStrategy, (second)));
        _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, HELD_LAUNCH - SHIP_LAUNCH, 1e6));
    }

    function test_updateStrategyBounds_clampsSpread_feeShareAndKindFixed() public {
        StrategyBounds memory b = _mmBounds();
        b.spreadBpsMin = 50;
        _asSafe(address(module), abi.encodeCall(MandateModule.updateStrategyBounds, (strategyId, b)));
        assertEq(module.getStrategy(strategyId).params.spreadBps, 50);

        b.mmFeeShareBps = 1000;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.FeeShareIsFixed.selector, 5000, 1000));
        safe.execute(address(module), abi.encodeCall(MandateModule.updateStrategyBounds, (strategyId, b)));

        b = _mmBounds();
        b.maxBuyPriceX36 = 1; // would turn a market-making strategy into a buyback one
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.InvalidStrategy.selector, "maxBuyPriceX36"));
        safe.execute(address(module), abi.encodeCall(MandateModule.updateStrategyBounds, (strategyId, b)));
    }

    // ================================================================ market maker: allowed

    function test_mm_reshipInsideBounds_oldVersionStops() public {
        bytes32 oldHash = module.getStrategy(strategyId).activeStrategyHash;
        ISwapVM.Order memory oldOrder = module.activeOrder(strategyId);

        vm.prank(mm);
        module.reship(strategyId, _params(80, SHIP_LAUNCH / 2, SHIP_USDC / 2));

        Strategy memory s = module.getStrategy(strategyId);
        assertEq(s.params.spreadBps, 80);
        assertTrue(s.activeStrategyHash != oldHash, "new hash");
        assertEq(module.strategyNonce(strategyId), 2);

        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(); // docked: Aqua has no balances for the old version
        taker.swap(oldOrder, address(usdc), address(launch), 1000e6, true);
        _buy(strategyId, 1000e18);
    }

    /// @notice Loophole 3: a reship must not reset the policy's counters.
    function test_mm_reshipKeepsPolicyCounters() public {
        _buy(strategyId, 50_000e18);
        vm.prank(mm);
        module.reship(strategyId, _params(30, SHIP_LAUNCH - 50_000e18, SHIP_USDC));
        assertEq(quoter.policyCounters(policyId).netSold, 50_000e18);
    }

    function test_mm_canPause_onlyIssuerUnpauses() public {
        vm.prank(mm);
        module.pauseStrategy(strategyId);
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.StrategyPaused.selector), 1000e18);

        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.unpauseStrategy(strategyId);

        _asSafe(address(module), abi.encodeCall(MandateModule.unpauseStrategy, (strategyId)));
        _buy(strategyId, 1000e18);
    }

    function test_mm_claimsShareOfFeesInBothTokens() public {
        _buy(strategyId, 30_000e18); // fee in USDC
        _sell(strategyId, 10_000e18); // fee in LAUNCH
        (uint256 baseFees, uint256 quoteFees) = quoter.feesAccrued(strategyId);
        (uint256 cb, uint256 cq) = module.claimable(strategyId);
        assertEq(cb, baseFees / 2, "50% share");
        assertEq(cq, quoteFees / 2, "50% share");

        uint256 safeBefore = usdc.balanceOf(address(safe));
        vm.prank(mm);
        module.claimFees(strategyId);
        assertEq(usdc.balanceOf(mm), cq);
        assertEq(launch.balanceOf(mm), cb);
        assertEq(usdc.balanceOf(address(safe)), safeBefore - cq);
        (uint256 db, uint256 dq) = module.claimed(strategyId);
        assertEq(db, cb);
        assertEq(dq, cq);

        vm.prank(mm);
        vm.expectRevert(IMandateModule.NothingToClaim.selector);
        module.claimFees(strategyId);
    }

    function test_mm_keepsEarnedFeesAfterRevoke() public {
        _buy(strategyId, 30_000e18);
        _asSafe(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        vm.prank(mm);
        (, uint256 q) = module.claimFees(strategyId);
        assertGt(q, 0);
    }

    // ================================================================ market maker: forbidden

    function test_mm_cannotExceedAnyBound() public {
        StrategyParams[5] memory bad = [
            _params(5, SHIP_LAUNCH, SHIP_USDC), // spread below min
            _params(201, SHIP_LAUNCH, SHIP_USDC), // spread above max
            _params(30, MandateFixture.ALLOTMENT + 1, SHIP_USDC), // more base than the bound
            _params(30, SHIP_LAUNCH, HELD_USDC + 1), // more quote than the bound
            _params(30, 0, SHIP_USDC) // empty side
        ];
        string[5] memory fields = ["spreadBps", "spreadBps", "shippedBase", "shippedQuote", "shippedBase"];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(mm);
            vm.expectRevert(abi.encodeWithSelector(IMandateModule.ParamsOutOfBounds.selector, fields[i]));
            module.reship(strategyId, bad[i]);
        }
    }

    function test_mm_cannotUseIssuerPowers() public {
        vm.startPrank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.revokeStrategy(strategyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.revokePolicy(policyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.updateStrategyBounds(strategyId, _mmBounds());
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.updatePolicy(policyId, _config());
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.pausePolicy(policyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.addStrategy(policyId, mm, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1e18, 1e6));
        vm.stopPrank();
    }

    /// @notice The market maker has no path to the Safe's tokens: not via the Safe, not via Aqua, not via the module.
    function test_mm_cannotMoveSafeTokens() public {
        vm.startPrank(mm);
        vm.expectRevert(MockSafe.NotOwner.selector);
        safe.execute(address(launch), abi.encodeCall(IERC20.transfer, (mm, 1)));

        vm.expectRevert(abi.encodeWithSelector(MockSafe.NotModule.selector, mm));
        safe.execTransactionFromModuleReturnData(
            address(launch), 0, abi.encodeCall(IERC20.transfer, (mm, 1)), ISafe.Operation.Call
        );

        // Aqua.pull only debits balances the caller itself is the app for: the market maker has none.
        bytes32 h = module.getStrategy(strategyId).activeStrategyHash;
        vm.expectRevert();
        aqua.pull(address(safe), h, address(launch), 1, mm);
        vm.stopPrank();

        assertEq(launch.balanceOf(mm), 0);
        assertEq(usdc.balanceOf(mm), 0);
    }

    function test_mm_powerlessAfterRevoke() public {
        _asSafe(address(module), abi.encodeCall(MandateModule.revokeStrategy, (strategyId)));
        vm.startPrank(mm);
        vm.expectRevert(IMandateModule.IsRevoked.selector);
        module.reship(strategyId, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.expectRevert(IMandateModule.NotActive.selector);
        module.pauseStrategy(strategyId);
        vm.stopPrank();
    }

    function test_mm_ofOneStrategyCannotTouchAnother() public {
        bytes32 second = _addStrategy(mm2, StrategyKind.MarketMaking, _mmBounds(), _params(30, 1000e18, 400e6));
        vm.startPrank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, mm));
        module.reship(second, _params(30, 1000e18, 400e6));
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, mm));
        module.claimFees(second);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuerOrMarketMaker.selector, mm));
        module.pauseStrategy(second);
        vm.stopPrank();
    }

    function test_stranger_hasNoPowers() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, stranger));
        module.reship(strategyId, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, stranger));
        module.claimFees(strategyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuerOrMarketMaker.selector, stranger));
        module.pauseStrategy(strategyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, stranger));
        module.revokeStrategy(strategyId);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, stranger));
        module.revokePolicy(policyId);
        vm.stopPrank();
    }

    /// @notice Another Safe that enabled the same module cannot touch this Safe's policy or strategies.
    function test_otherSafe_cannotTouchPolicy() public {
        MockSafe other = new MockSafe(owner);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, address(other)));
        other.execute(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, address(other)));
        other.execute(address(module), abi.encodeCall(MandateModule.revokeStrategy, (strategyId)));
    }

    // ================================================================ helpers

    function _config() internal view returns (PolicyConfig memory) {
        return MandateFixture.policyConfig(address(oracle), uint64(block.timestamp - 20 days));
    }

    function _mmBounds() internal pure returns (StrategyBounds memory) {
        return MandateFixture.marketMakingBounds(MandateFixture.ALLOTMENT, HELD_USDC);
    }

    function _params(uint16 spread, uint256 base, uint256 quote) internal pure returns (StrategyParams memory) {
        return StrategyParams({ spreadBps: spread, shippedBase: base, shippedQuote: quote });
    }

    function _createPolicy(PolicyConfig memory c) internal returns (bytes32) {
        bytes memory ret = _asSafe(
            address(module), abi.encodeCall(MandateModule.createPolicy, (address(launch), address(usdc), c))
        );
        return abi.decode(ret, (bytes32));
    }

    function _addStrategy(address maker, StrategyKind kind, StrategyBounds memory b, StrategyParams memory p)
        internal
        returns (bytes32)
    {
        bytes memory ret =
            _asSafe(address(module), abi.encodeCall(MandateModule.addStrategy, (policyId, maker, kind, b, p)));
        return abi.decode(ret, (bytes32));
    }

    function _asSafe(address to, bytes memory data) internal returns (bytes memory) {
        vm.prank(owner);
        return safe.execute(to, data);
    }

    /// @dev Taker buys exactly `launchOut` LAUNCH from the strategy (a treasury sell). Returns USDC paid.
    function _buy(bytes32 id, uint256 launchOut) internal returns (uint256 usdcIn) {
        ISwapVM.Order memory o = module.activeOrder(id);
        (usdcIn,) = taker.quote(o, address(usdc), address(launch), launchOut, false);
        usdc.mint(address(taker), usdcIn);
        taker.swap(o, address(usdc), address(launch), launchOut, false);
    }

    /// @dev Taker sells exactly `launchIn` LAUNCH to the strategy (a treasury buy). Returns USDC received.
    function _sell(bytes32 id, uint256 launchIn) internal returns (uint256 usdcOut) {
        launch.mint(address(taker), launchIn);
        (, usdcOut) = taker.swap(module.activeOrder(id), address(launch), address(usdc), launchIn, true);
    }

    function _expectBuyRevert(bytes memory err, uint256 launchOut) internal {
        _expectBuyRevertOn(strategyId, err, launchOut);
    }

    function _expectBuyRevertOn(bytes32 id, bytes memory err, uint256 launchOut) internal {
        ISwapVM.Order memory o = module.activeOrder(id);
        usdc.mint(address(taker), launchOut);
        vm.expectRevert(err);
        taker.swap(o, address(usdc), address(launch), launchOut, false);
    }
}

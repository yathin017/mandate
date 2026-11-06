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
import { Mandate, MandateBounds, MandateParams, MandateStatus } from "../../src/libraries/MandateTypes.sol";
import { ISafe } from "../../src/interfaces/ISafe.sol";
import { MandateModule } from "../../src/module/MandateModule.sol";
import { MandateQuoter } from "../../src/quoter/MandateQuoter.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";

import { AquaTaker } from "../utils/AquaTaker.sol";
import { MandateFixture } from "../utils/MandateFixture.sol";
import { MockPriceAnchor } from "../utils/MockPriceAnchor.sol";
import { MockSafe } from "../utils/MockSafe.sol";

/// @title MandateModuleIntegrationTest
/// @notice MandateModule + its quoter behind real Aqua/router bytecode (pinned v1.0.2 source), with a mock Safe.
///         Every permission in spec §5 is tested, especially what the market maker must never be able to do.
contract MandateModuleIntegrationTest is Test {
    uint256 internal constant SHIP_LAUNCH = 10_000_000e18;
    uint256 internal constant SHIP_USDC = 4_000_000e6;
    uint256 internal constant EPOCH_CAP = 50_000e18;

    address internal owner = makeAddr("safeOwner");
    address internal mm = makeAddr("marketMaker");
    address internal stranger = makeAddr("stranger");

    IAqua internal aqua;
    ISwapVM internal router;
    MandateModule internal module;
    MandateQuoter internal quoter;
    MockSafe internal safe;
    MockERC20 internal launch;
    MockERC20 internal usdc;
    MockPriceAnchor internal anchor;
    AquaTaker internal taker;
    bytes32 internal id;

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
        anchor = new MockPriceAnchor();
        anchor.setPrice(MandateFixture.SPOT_X36);
        taker = new AquaTaker(aqua, router);

        safe = new MockSafe(owner);
        launch.mint(address(safe), SHIP_LAUNCH);
        usdc.mint(address(safe), SHIP_USDC);
        _asSafe(address(safe), abi.encodeCall(MockSafe.enableModule, (address(module))));

        id = _create(_bounds(), _params(30, SHIP_LAUNCH, SHIP_USDC));
    }

    // ================================================================ create

    function test_create_shipsStrategyAndRegistersTerms() public view {
        Mandate memory m = module.getMandate(id);
        assertEq(m.safe, address(safe));
        assertEq(m.mm, mm);
        assertEq(uint8(m.status), uint8(MandateStatus.Active));
        assertEq(m.bounds.quoter, address(quoter), "quoter forced to module's");
        assertEq(m.activeStrategyHash, router.hash(module.activeOrder(id)), "active order hash");
        assertEq(IERC20(address(launch)).allowance(address(safe), address(aqua)), type(uint256).max);

        (uint256 b, uint256 q) =
            aqua.safeBalances(address(safe), address(router), m.activeStrategyHash, address(launch), address(usdc));
        assertEq(b, SHIP_LAUNCH);
        assertEq(q, SHIP_USDC);
        assertEq(module.mandatesOf(address(safe)).length, 1);
        assertEq(address(quoter.REGISTRY()), address(module));
    }

    function test_create_requiresModuleEnabled() public {
        MockSafe other = new MockSafe(owner);
        vm.prank(owner);
        vm.expectRevert(); // bubbled ModuleNotEnabled
        other.execute(
            address(module),
            abi.encodeCall(
                MandateModule.createMandate,
                (mm, address(launch), address(usdc), _bounds(), _params(30, SHIP_LAUNCH, SHIP_USDC))
            )
        );
    }

    function test_create_rejectsInvalidBounds() public {
        MandateBounds memory b = _bounds();
        b.spreadBpsMax = b.maxAnchorDeviationBps; // spread alone could leave the anchor band
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.InvalidBounds.selector, "spreadBpsMax"));
        safe.execute(
            address(module),
            abi.encodeCall(
                MandateModule.createMandate,
                (mm, address(launch), address(usdc), b, _params(30, SHIP_LAUNCH, SHIP_USDC))
            )
        );
    }

    function test_mandateIdsAreUniquePerSafe() public {
        bytes32 second = _create(_bounds(), _params(30, 1000e18, 400e6));
        assertTrue(second != id);
        assertEq(module.mandatesOf(address(safe)).length, 2);
    }

    // ================================================================ trading through the module's strategy

    function test_fill_viaActiveOrder_movesSafeTokens() public {
        uint256 usdcIn = _buy(10_000e18);
        assertEq(launch.balanceOf(address(safe)), SHIP_LAUNCH - 10_000e18);
        assertEq(usdc.balanceOf(address(safe)), SHIP_USDC + usdcIn);
    }

    // ================================================================ market maker: allowed

    function test_mm_reshipInsideBounds() public {
        bytes32 oldHash = module.getMandate(id).activeStrategyHash;
        ISwapVM.Order memory oldOrder = module.activeOrder(id);

        vm.prank(mm);
        module.reship(id, _params(80, SHIP_LAUNCH / 2, SHIP_USDC / 2));

        Mandate memory m = module.getMandate(id);
        assertEq(m.params.spreadBps, 80);
        assertTrue(m.activeStrategyHash != oldHash, "new hash");
        assertEq(module.strategyNonce(id), 2);

        // Old strategy is docked: it can no longer trade.
        usdc.mint(address(taker), 1000e6);
        vm.expectRevert();
        taker.swap(oldOrder, address(usdc), address(launch), 1000e6, true);
        // New one trades.
        _buy(1000e18);
    }

    function test_mm_reshipCountsSoldInventory() public {
        _buy(40_000e18);
        // Only allotment - 40k may be shipped now.
        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.ParamsOutOfBounds.selector, "shippedBase"));
        module.reship(id, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.prank(mm);
        module.reship(id, _params(30, SHIP_LAUNCH - 40_000e18, SHIP_USDC));
    }

    function test_mm_canPause_onlyIssuerUnpauses() public {
        vm.prank(mm);
        module.pause(id);
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.MandatePaused.selector));

        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.unpause(id);

        _asSafe(address(module), abi.encodeCall(MandateModule.unpause, (id)));
        _buy(1000e18);
    }

    function test_mm_claimsShareOfFees() public {
        _buy(30_000e18);
        (, uint256 quoteFees) = quoter.feesAccrued(id);
        (uint256 cb, uint256 cq) = module.claimable(id);
        assertEq(cb, 0);
        assertEq(cq, quoteFees / 2, "50% share");

        uint256 safeBefore = usdc.balanceOf(address(safe));
        vm.prank(mm);
        module.claimFees(id);
        assertEq(usdc.balanceOf(mm), cq);
        assertEq(usdc.balanceOf(address(safe)), safeBefore - cq);

        // Nothing more until new fills.
        vm.prank(mm);
        vm.expectRevert(IMandateModule.NothingToClaim.selector);
        module.claimFees(id);
    }

    function test_mm_keepsEarnedFeesAfterRevoke() public {
        _buy(30_000e18);
        _asSafe(address(module), abi.encodeCall(MandateModule.revoke, (id)));
        vm.prank(mm);
        (, uint256 q) = module.claimFees(id);
        assertGt(q, 0);
    }

    // ================================================================ market maker: forbidden

    function test_mm_cannotExceedAnyBound() public {
        MandateParams[5] memory bad = [
            _params(5, SHIP_LAUNCH, SHIP_USDC), // spread below min
            _params(201, SHIP_LAUNCH, SHIP_USDC), // spread above max
            _params(30, SHIP_LAUNCH + 1, SHIP_USDC), // more than allotment
            _params(30, SHIP_LAUNCH, MandateFixture.MAX_SHIPPED_QUOTE + 1), // more quote than committed
            _params(30, 0, SHIP_USDC) // empty side
        ];
        string[5] memory fields = ["spreadBps", "spreadBps", "shippedBase", "shippedQuote", "shippedBase"];
        for (uint256 i; i < bad.length; i++) {
            vm.prank(mm);
            vm.expectRevert(abi.encodeWithSelector(IMandateModule.ParamsOutOfBounds.selector, fields[i]));
            module.reship(id, bad[i]);
        }

        MandateParams memory overCap = _params(30, SHIP_LAUNCH, SHIP_USDC);
        overCap.epochCap = EPOCH_CAP + 1;
        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.ParamsOutOfBounds.selector, "epochCap"));
        module.reship(id, overCap);
    }

    function test_mm_cannotUseIssuerPowers() public {
        vm.startPrank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.revoke(id);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.updateBounds(id, _bounds());
        vm.stopPrank();
    }

    /// @notice The MM has no path to the Safe's tokens: not via the Safe, not via Aqua, not via the module.
    function test_mm_cannotMoveSafeTokens() public {
        vm.startPrank(mm);
        vm.expectRevert(MockSafe.NotOwner.selector);
        safe.execute(address(launch), abi.encodeCall(IERC20.transfer, (mm, 1)));

        vm.expectRevert(abi.encodeWithSelector(MockSafe.NotModule.selector, mm));
        safe.execTransactionFromModuleReturnData(
            address(launch), 0, abi.encodeCall(IERC20.transfer, (mm, 1)), ISafe.Operation.Call
        );

        // Aqua.pull only debits balances the caller itself is the app for: the MM has none.
        bytes32 h = module.getMandate(id).activeStrategyHash;
        vm.expectRevert();
        aqua.pull(address(safe), h, address(launch), 1, mm);
        vm.stopPrank();

        assertEq(launch.balanceOf(mm), 0);
        assertEq(usdc.balanceOf(mm), 0);
    }

    function test_mm_powerlessAfterRevoke() public {
        _asSafe(address(module), abi.encodeCall(MandateModule.revoke, (id)));
        vm.startPrank(mm);
        vm.expectRevert(IMandateModule.MandateIsRevoked.selector);
        module.reship(id, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.expectRevert(IMandateModule.MandateNotActive.selector);
        module.pause(id);
        vm.stopPrank();
    }

    function test_stranger_hasNoPowers() public {
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, stranger));
        module.reship(id, _params(30, SHIP_LAUNCH, SHIP_USDC));
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotMarketMaker.selector, stranger));
        module.claimFees(id);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuerOrMarketMaker.selector, stranger));
        module.pause(id);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, stranger));
        module.revoke(id);
        vm.stopPrank();
    }

    /// @notice Another Safe that enabled the same module cannot touch this Safe's mandate.
    function test_otherSafe_cannotTouchMandate() public {
        MockSafe other = new MockSafe(owner);
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, address(other)));
        other.execute(address(module), abi.encodeCall(MandateModule.revoke, (id)));
    }

    // ================================================================ issuer

    function test_revoke_docksAndBlocksForever() public {
        _asSafe(address(module), abi.encodeCall(MandateModule.revoke, (id)));
        assertEq(uint8(module.getMandate(id).status), uint8(MandateStatus.Revoked));
        ISwapVM.Order memory o = module.activeOrder(id);
        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(); // docked: Aqua has no balances for the strategy
        taker.swap(o, address(usdc), address(launch), 1000e6, true);

        vm.prank(owner);
        vm.expectRevert(IMandateModule.MandateNotPaused.selector);
        safe.execute(address(module), abi.encodeCall(MandateModule.unpause, (id)));
    }

    /// @notice Even with the module disabled, revoke succeeds and the quoter refuses every fill.
    function test_revoke_cannotBeBlocked() public {
        _asSafe(address(safe), abi.encodeCall(MockSafe.disableModule, (address(module))));
        vm.expectEmit(address(module));
        emit IMandateModule.MandateRevoked(id, false);
        _asSafe(address(module), abi.encodeCall(MandateModule.revoke, (id)));

        // Strategy still shipped, but the quoter refuses.
        _expectBuyRevert(abi.encodeWithSelector(IMandateQuoter.MandateRevoked.selector));
    }

    function test_updateBounds_clampsLiveParams_feeShareFixed() public {
        MandateBounds memory b = _bounds();
        b.spreadBpsMin = 50;
        b.maxEpochCap = 20_000e18;
        _asSafe(address(module), abi.encodeCall(MandateModule.updateBounds, (id, b)));
        Mandate memory m = module.getMandate(id);
        assertEq(m.params.spreadBps, 50);
        assertEq(m.params.epochCap, 20_000e18);

        b.mmFeeShareBps = 1000;
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.FeeShareIsFixed.selector, 5000, 1000));
        safe.execute(address(module), abi.encodeCall(MandateModule.updateBounds, (id, b)));
    }

    // ================================================================ helpers

    function _bounds() internal view returns (MandateBounds memory b) {
        b =
        MandateFixture.defaultMandate(
            address(0),
            address(0),
            address(0),
            address(0),
            address(anchor),
            address(0),
            uint64(block.timestamp - 20 days)
        )
        .bounds;
        b.maxEpochCap = EPOCH_CAP;
    }

    function _params(
        uint16 spread,
        uint256 shippedBase,
        uint256 shippedQuote
    )
        internal
        pure
        returns (MandateParams memory)
    {
        return
            MandateParams({
                spreadBps: spread, epochCap: EPOCH_CAP, shippedBase: shippedBase, shippedQuote: shippedQuote
            });
    }

    function _create(MandateBounds memory b, MandateParams memory p) internal returns (bytes32) {
        bytes memory ret = _asSafe(
            address(module), abi.encodeCall(MandateModule.createMandate, (mm, address(launch), address(usdc), b, p))
        );
        return abi.decode(ret, (bytes32));
    }

    function _asSafe(address to, bytes memory data) internal returns (bytes memory) {
        vm.prank(owner);
        return safe.execute(to, data);
    }

    function _buy(uint256 launchOut) internal returns (uint256 usdcIn) {
        ISwapVM.Order memory o = module.activeOrder(id);
        (usdcIn,) = taker.quote(o, address(usdc), address(launch), launchOut, false);
        usdc.mint(address(taker), usdcIn);
        taker.swap(o, address(usdc), address(launch), launchOut, false);
    }

    function _expectBuyRevert(bytes memory err) internal {
        ISwapVM.Order memory o = module.activeOrder(id);
        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(err);
        taker.swap(o, address(usdc), address(launch), 1000e6, true);
    }
}

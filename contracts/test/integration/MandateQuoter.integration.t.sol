// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { AquaSwapVMRouter } from "@1inch/swap-vm/src/routers/AquaSwapVMRouter.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";

import { MandateVenueSetup } from "../utils/MandateVenueSetup.sol";

/// @title MandateQuoterIntegrationTest
/// @notice MandateQuoter behind real Aqua + AquaSwapVMRouter bytecode, deployed from the pinned swap-vm v1.0.2
///         source (same version as mainnet). Runs offline; the fork suite repeats the key path on mainnet.
contract MandateQuoterIntegrationTest is MandateVenueSetup {
    function _venue() internal override returns (IAqua, ISwapVM) {
        Aqua a = new Aqua();
        AquaSwapVMRouter r = new AquaSwapVMRouter(address(a), address(0), address(this), "1inch SwapVM v1.0", "1.0.2");
        return (IAqua(address(a)), ISwapVM(address(r)));
    }

    function setUp() public {
        vm.warp(1_800_000_000);
        _setUpMandate();
    }

    function test_sell_movesRealTokensFromSafe() public {
        uint256 launchOut = 30_000e18;
        uint256 usdcIn = _buyLaunch(order, launchOut);

        assertEq(launch.balanceOf(safe), SHIP_LAUNCH - launchOut, "safe LAUNCH");
        assertEq(usdc.balanceOf(safe), SHIP_USDC + usdcIn, "safe USDC");
        assertEq(launch.balanceOf(address(taker)), launchOut, "taker LAUNCH");
        assertEq(usdc.balanceOf(address(taker)), 0, "taker USDC");

        (, uint256 net, uint256 total) = quoter.epochState(ID);
        assertEq(net, launchOut);
        assertEq(total, launchOut);
        (, uint256 quoteFees) = quoter.feesAccrued(ID);
        assertGt(quoteFees, 0, "spread accrued");
    }

    /// @notice Quote == swap for random sizes, both directions and both modes.
    function testFuzz_quoteEqualsSwap(uint256 amount, bool isSell, bool isExactIn) public {
        (address tokenIn, address tokenOut) =
            isSell ? (address(usdc), address(launch)) : (address(launch), address(usdc));
        if (isSell) {
            amount = isExactIn ? bound(amount, 1e6, 10_000e6) : bound(amount, 1e18, 20_000e18);
        } else {
            amount = isExactIn ? bound(amount, 1e18, 20_000e18) : bound(amount, 1e6, 8000e6);
        }

        (uint256 qIn, uint256 qOut) = taker.quote(order, tokenIn, tokenOut, amount, isExactIn);
        if (isSell) usdc.mint(address(taker), qIn);
        else launch.mint(address(taker), qIn);
        (uint256 sIn, uint256 sOut) = taker.swap(order, tokenIn, tokenOut, amount, isExactIn);

        assertEq(sIn, qIn, "amountIn");
        assertEq(sOut, qOut, "amountOut");
    }

    function test_epochCap_throughRouter_resetsNextEpoch() public {
        _buyLaunch(order, 30_000e18);

        (uint256 usdcIn,) = taker.quote(order, address(usdc), address(launch), 20_000e18, false);
        usdc.mint(address(taker), usdcIn);
        // 30k + 30k > 50k cap
        vm.expectRevert(
            abi.encodeWithSelector(IMandateQuoter.EpochCapReached.selector, 30_000e18, 30_000e18, EPOCH_CAP)
        );
        taker.swap(order, address(usdc), address(launch), 30_000e18, false);

        _buyLaunch(order, 20_000e18); // exactly to the cap
        assertEq(quoter.remainingThisEpoch(ID), 0);

        vm.warp(quoter.epochResetsAt(ID));
        _buyLaunch(order, 30_000e18);
    }

    function test_buyback_restoresCapacity() public {
        _buyLaunch(order, 40_000e18);
        assertEq(quoter.remainingThisEpoch(ID), 10_000e18);

        launch.mint(address(taker), 25_000e18);
        taker.swap(order, address(launch), address(usdc), 25_000e18, true);
        assertEq(quoter.remainingThisEpoch(ID), 35_000e18);
    }

    /// @notice Griefing guard: a stranger ships their own strategy pointing at our mandate id.
    function test_foreignStrategy_cannotConsumeCapacity() public {
        address attacker = makeAddr("attacker");
        launch.mint(attacker, 1_000_000e18);
        usdc.mint(attacker, 400_000e6);
        vm.startPrank(attacker);
        launch.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
        (ISwapVM.Order memory evil,) = _shipFrom(attacker, 1, 1_000_000e18, 400_000e6);

        usdc.mint(address(taker), 10_000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.WrongMaker.selector, attacker, safe));
        taker.swap(evil, address(usdc), address(launch), 10_000e6, true);
        assertEq(quoter.remainingThisEpoch(ID), EPOCH_CAP, "capacity untouched");
    }

    /// @notice Only the strategy the registry marks active may trade, even if the Safe shipped another.
    function test_inactiveStrategy_rejected() public {
        (ISwapVM.Order memory second, bytes32 secondHash) = _shipFrom(safe, 2, 100_000e18, 40_000e6);
        registry.setActiveStrategy(ID, secondHash);

        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.InactiveStrategy.selector, strategyHash, secondHash));
        taker.swap(order, address(usdc), address(launch), 1000e6, true);

        // The active one trades.
        taker.swap(second, address(usdc), address(launch), 100e6, true);
    }

    function test_directStatefulCall_reverts() public {
        SwapQuery memory q = SwapQuery({
            orderHash: strategyHash,
            maker: safe,
            taker: address(this),
            tokenIn: address(usdc),
            tokenOut: address(launch),
            isExactIn: true
        });
        SwapRegisters memory regs = SwapRegisters({
            balanceIn: SHIP_USDC, balanceOut: SHIP_LAUNCH, amountIn: 1e6, amountOut: 0, amountNetPulled: 0
        });
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.NotRouter.selector, address(this)));
        quoter.extruction(false, 0, q, regs, abi.encodePacked(ID), "");
    }

    function test_anchorStatus_readsAquaSpot() public view {
        (uint256 spot, uint256 twap, uint256 dev, bool ok) = quoter.anchorStatus(ID);
        assertEq(spot, 4e23);
        assertEq(twap, 4e23);
        assertEq(dev, 0);
        assertTrue(ok);
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

import { MandateVenueSetup } from "../utils/MandateVenueSetup.sol";

/// @title MandateQuoterForkTest
/// @notice Key quoter paths against the canonical Aqua + AquaSwapVMRouter on a mainnet fork, proving the
///         deployed bytecode behaves like the pinned source used by the integration suite.
/// @dev Skipped when the chain's RPC env var is unset.
contract MandateQuoterForkTest is MandateVenueSetup {
    function _venue() internal override returns (IAqua, ISwapVM) {
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
    }

    function test_fork_sellWithinLimits_thenEpochCapBlocks() public {
        uint256 usdcIn = _buyLaunch(order, 30_000e18);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH - 30_000e18, "safe LAUNCH");
        assertEq(usdc.balanceOf(safe), SHIP_USDC + usdcIn, "safe USDC");

        // Quote and swap share the rules, so the quote itself already refuses.
        bytes memory capErr =
            abi.encodeWithSelector(IMandateQuoter.EpochCapReached.selector, 30_000e18, 30_000e18, EPOCH_CAP);
        vm.expectRevert(capErr);
        taker.quote(order, address(usdc), address(launch), 30_000e18, false);

        usdc.mint(address(taker), 20_000e6);
        vm.expectRevert(capErr);
        taker.swap(order, address(usdc), address(launch), 30_000e18, false);
    }

    function test_fork_quoteEqualsSwap() public {
        (uint256 qIn, uint256 qOut) = taker.quote(order, address(usdc), address(launch), 5000e6, true);
        usdc.mint(address(taker), qIn);
        (uint256 sIn, uint256 sOut) = taker.swap(order, address(usdc), address(launch), 5000e6, true);
        assertEq(sIn, qIn);
        assertEq(sOut, qOut);
    }

    function test_fork_anchorDeviationBlocks() public {
        anchor.setPrice(3.6e23); // 10% below the pool
        usdc.mint(address(taker), 1000e6);
        vm.expectPartialRevert(IMandateQuoter.AnchorDeviation.selector);
        taker.swap(order, address(usdc), address(launch), 1000e6, true);
    }
}

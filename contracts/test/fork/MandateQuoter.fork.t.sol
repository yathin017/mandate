// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { MandateMath } from "../../src/libraries/MandateMath.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";
import { MandateVenueSetup } from "../utils/MandateVenueSetup.sol";

/// @title MandateQuoterForkTest
/// @notice Key quoter paths against the canonical Aqua + AquaSwapVMRouter on a mainnet fork, proving the
///         deployed bytecode behaves like the pinned source used by the integration suite.
/// @dev Skipped when the chain's RPC env var is unset.
contract MandateQuoterForkTest is MandateVenueSetup {
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
        _setUpPolicy();
    }

    function test_fork_sellsCountAgainstThePolicy_thenNetCapBlocks() public {
        uint256 usdcIn = _buyLaunch(order, 100_000e18);
        assertEq(launch.balanceOf(safe), 10 * SHIP_LAUNCH - 100_000e18, "safe LAUNCH");
        assertEq(usdc.balanceOf(safe), 10 * SHIP_USDC + usdcIn, "safe USDC");
        oracle.setFlat(_preTradePrice(), DEEP);
        _buyLaunch(order, 100_000e18);
        oracle.setFlat(_preTradePrice(), DEEP);

        // Quote and swap share the rules, so the quote itself already refuses.
        bytes memory capErr = abi.encodeWithSelector(
            IMandateQuoter.NetSellCapReached.selector, 200_000e18, 1000e18, MandateFixture.NET_CAP
        );
        vm.expectRevert(capErr);
        taker.quote(order, address(usdc), address(launch), 1000e18, false);

        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(capErr);
        taker.swap(order, address(usdc), address(launch), 1000e18, false);
    }

    function test_fork_quoteEqualsSwap() public {
        (uint256 qIn, uint256 qOut) = taker.quote(order, address(usdc), address(launch), 5000e6, true);
        usdc.mint(address(taker), qIn);
        (uint256 sIn, uint256 sOut) = taker.swap(order, address(usdc), address(launch), 5000e6, true);
        assertEq(sIn, qIn);
        assertEq(sOut, qOut);
    }

    function test_fork_offMarketQuoteBlocks() public {
        oracle.setFlat(3.6e23, DEEP); // market 10% below the strategy
        usdc.mint(address(taker), 1000e6);
        vm.expectPartialRevert(IMandateQuoter.QuoteOffMarket.selector);
        taker.swap(order, address(usdc), address(launch), 1000e6, true);
    }

    function _preTradePrice() internal view returns (uint256) {
        (uint256 b, uint256 q) = aqua.safeBalances(safe, address(router), strategyHash, address(launch), address(usdc));
        return MandateMath.price(b, q);
    }
}

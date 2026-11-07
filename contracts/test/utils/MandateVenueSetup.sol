// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IMandateRegistry } from "../../src/interfaces/IMandateRegistry.sol";
import { AquaProgram } from "../../src/libraries/AquaProgram.sol";
import { Policy, Status, Strategy, StrategyKind } from "../../src/libraries/MandateTypes.sol";
import { MandateQuoter } from "../../src/quoter/MandateQuoter.sol";
import { AquaTaker } from "../../src/mocks/AquaTaker.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";

import { AquaOrders } from "./AquaOrders.sol";
import { MandateFixture } from "./MandateFixture.sol";
import { MockMandateRegistry } from "./MockMandateRegistry.sol";
import { MockMarketOracle } from "./MockMarketOracle.sol";

/// @title MandateVenueSetup
/// @notice Shared setup for running MandateQuoter behind a real Aqua + AquaSwapVMRouter, with a settable registry and
///         market oracle so each rule can be driven directly. Subclasses pick the venue: freshly deployed from pinned
///         source (integration) or the canonical deployment (fork).
/// @dev Quoter-focused tests use a plain maker address. The module's own suites use a Safe.
abstract contract MandateVenueSetup is Test {
    bytes32 internal constant POLICY_ID = keccak256("policy-1");
    bytes32 internal constant STRATEGY_ID = keccak256("strategy-1");
    uint256 internal constant SHIP_LAUNCH = 10_000_000e18;
    uint256 internal constant SHIP_USDC = 4_000_000e6; // pre-trade price 0.40
    /// @dev Trusted depth reported by the oracle in the healthy case: large enough not to bind.
    uint256 internal constant DEEP = 100_000_000e18;

    IAqua internal aqua;
    ISwapVM internal router;

    MockERC20 internal launch;
    MockERC20 internal usdc;
    address internal safe = makeAddr("issuerSafe");
    address internal mm = makeAddr("mm");
    AquaTaker internal taker;

    MockMandateRegistry internal registry;
    MockMarketOracle internal oracle;
    MandateQuoter internal quoter;

    ISwapVM.Order internal order;
    bytes32 internal strategyHash;

    /// @dev Returns the Aqua + router the test runs against.
    function _venue() internal virtual returns (IAqua, ISwapVM);

    function _setUpPolicy() internal {
        (aqua, router) = _venue();

        launch = new MockERC20("Launch Token", "LAUNCH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        taker = new AquaTaker(aqua, router);

        registry = new MockMandateRegistry();
        oracle = new MockMarketOracle();
        oracle.setFlat(MandateFixture.SPOT_X36, DEEP);
        quoter = new MandateQuoter(address(router), IMandateRegistry(address(registry)));

        // Day 20 of a 180-day release, so inventory is already unlocked.
        registry.setPolicy(
            POLICY_ID,
            Policy({
                safe: safe,
                base: address(launch),
                quote: address(usdc),
                status: Status.Active,
                config: MandateFixture.policyConfig(address(oracle), uint64(block.timestamp - 20 days))
            })
        );

        // The Safe keeps its tokens; it only approves Aqua.
        launch.mint(safe, 10 * SHIP_LAUNCH);
        usdc.mint(safe, 10 * SHIP_USDC);
        vm.startPrank(safe);
        launch.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        (order, strategyHash) = _addStrategy(STRATEGY_ID, StrategyKind.MarketMaking, 0, SHIP_LAUNCH, SHIP_USDC);
    }

    /// @dev Registers a strategy under POLICY_ID and ships its first order from the Safe.
    function _addStrategy(bytes32 id, StrategyKind kind, uint256 maxBuyPriceX36, uint256 base, uint256 quote)
        internal
        returns (ISwapVM.Order memory o, bytes32 hash)
    {
        Strategy memory s = Strategy({
            policyId: POLICY_ID,
            mm: mm,
            kind: kind,
            status: Status.Active,
            activeStrategyHash: bytes32(0),
            bounds: MandateFixture.marketMakingBounds(type(uint128).max, type(uint128).max),
            params: MandateFixture.params(base, quote)
        });
        s.bounds.maxBuyPriceX36 = maxBuyPriceX36;
        registry.setStrategy(id, s);
        (o, hash) = _shipFrom(safe, id, 1, base, quote);
        registry.setActiveStrategy(id, hash);
    }

    /// @dev Ships `[Salt(nonce), Extruction(quoter, id)]` from `maker` with the given balances.
    function _shipFrom(address maker, bytes32 id, uint256 nonce, uint256 launchAmount, uint256 usdcAmount)
        internal
        returns (ISwapVM.Order memory o, bytes32 hash)
    {
        o = AquaOrders.build(
            maker, bytes.concat(AquaProgram.salt(nonce), AquaProgram.extruction(address(quoter), abi.encodePacked(id)))
        );
        address[] memory tokens = new address[](2);
        tokens[0] = address(launch);
        tokens[1] = address(usdc);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = launchAmount;
        amounts[1] = usdcAmount;
        vm.prank(maker);
        hash = aqua.ship(address(router), abi.encode(o), tokens, amounts);
    }

    /// @dev Taker buys exactly `launchOut` LAUNCH from the treasury (a treasury sell). Returns USDC paid.
    function _buyLaunch(ISwapVM.Order memory o, uint256 launchOut) internal returns (uint256 usdcIn) {
        (usdcIn,) = taker.quote(o, address(usdc), address(launch), launchOut, false);
        usdc.mint(address(taker), usdcIn);
        uint256 amountOut;
        (usdcIn, amountOut) = taker.swap(o, address(usdc), address(launch), launchOut, false);
        assertEq(amountOut, launchOut);
    }

    /// @dev Taker sells exactly `launchIn` LAUNCH to the treasury (a treasury buy). Returns USDC received.
    function _sellLaunch(ISwapVM.Order memory o, uint256 launchIn) internal returns (uint256 usdcOut) {
        launch.mint(address(taker), launchIn);
        (, usdcOut) = taker.swap(o, address(launch), address(usdc), launchIn, true);
    }
}

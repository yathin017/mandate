// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IMandateRegistry } from "../../src/interfaces/IMandateRegistry.sol";
import { Mandate } from "../../src/libraries/MandateTypes.sol";
import { AquaProgram } from "../../src/libraries/AquaProgram.sol";
import { MandateQuoter } from "../../src/quoter/MandateQuoter.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";

import { AquaOrders } from "./AquaOrders.sol";
import { AquaTaker } from "./AquaTaker.sol";
import { MandateFixture } from "./MandateFixture.sol";
import { MockMandateRegistry } from "./MockMandateRegistry.sol";
import { MockPriceAnchor } from "./MockPriceAnchor.sol";

/// @title MandateVenueSetup
/// @notice Shared setup for running MandateQuoter behind a real Aqua + AquaSwapVMRouter. Subclasses pick the
///         venue: freshly deployed from pinned source (integration) or the canonical deployment (fork).
/// @dev The Safe is a plain address until MandateModule lands (Segment 4); Aqua only needs it as `msg.sender`.
abstract contract MandateVenueSetup is Test {
    bytes32 internal constant ID = keccak256("mandate-1");
    uint256 internal constant SHIP_LAUNCH = 10_000_000e18;
    uint256 internal constant SHIP_USDC = 4_000_000e6; // spot 0.40
    /// @dev Small cap keeps one epoch's price impact well inside the 3% anchor band.
    uint256 internal constant EPOCH_CAP = 50_000e18;

    IAqua internal aqua;
    ISwapVM internal router;

    MockERC20 internal launch;
    MockERC20 internal usdc;
    address internal safe = makeAddr("issuerSafe");
    AquaTaker internal taker;

    MockMandateRegistry internal registry;
    MockPriceAnchor internal anchor;
    MandateQuoter internal quoter;

    ISwapVM.Order internal order;
    bytes32 internal strategyHash;

    /// @dev Returns the Aqua + router the test runs against.
    function _venue() internal virtual returns (IAqua, ISwapVM);

    function _setUpMandate() internal {
        (aqua, router) = _venue();

        launch = new MockERC20("Launch Token", "LAUNCH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        taker = new AquaTaker(aqua, router);

        registry = new MockMandateRegistry();
        anchor = new MockPriceAnchor();
        anchor.setPrice(MandateFixture.SPOT_X36);
        quoter = new MandateQuoter(address(router), aqua, IMandateRegistry(address(registry)));

        // Day 20 of a 180-day release.
        Mandate memory m = MandateFixture.defaultMandate(
            safe,
            makeAddr("mm"),
            address(launch),
            address(usdc),
            address(anchor),
            address(quoter),
            uint64(block.timestamp - 20 days)
        );
        m.bounds.maxEpochCap = EPOCH_CAP;
        m.params.epochCap = EPOCH_CAP;
        m.params.shippedBase = SHIP_LAUNCH;
        m.params.shippedQuote = SHIP_USDC;
        registry.set(ID, m);

        // The Safe keeps its tokens; it only approves Aqua.
        launch.mint(safe, SHIP_LAUNCH);
        usdc.mint(safe, SHIP_USDC);
        vm.startPrank(safe);
        launch.approve(address(aqua), type(uint256).max);
        usdc.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        (order, strategyHash) = _shipFrom(safe, 1, SHIP_LAUNCH, SHIP_USDC);
        registry.setActiveStrategy(ID, strategyHash);
    }

    /// @dev Ships `[Salt(nonce), Extruction(quoter, ID)]` from `maker` with the given balances.
    function _shipFrom(
        address maker,
        uint256 nonce,
        uint256 launchAmount,
        uint256 usdcAmount
    )
        internal
        returns (ISwapVM.Order memory o, bytes32 hash)
    {
        o = AquaOrders.build(
            maker, bytes.concat(AquaProgram.salt(nonce), AquaProgram.extruction(address(quoter), abi.encodePacked(ID)))
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
}

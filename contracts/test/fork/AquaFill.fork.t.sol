// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {TokenMock} from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {MakerTraitsLib} from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import {ChainConfig, ChainConfigLib} from "../../script/lib/ChainConfig.sol";
import {AquaProgram} from "../../src/libraries/AquaProgram.sol";
import {AquaTaker} from "../utils/AquaTaker.sol";
import {ProbeExtruction} from "../utils/ProbeExtruction.sol";

/// @title AquaFillForkTest
/// @notice Proves the end-to-end Aqua flow against the canonical deployed contracts on a mainnet fork:
///         maker ships a strategy (tokens stay in the maker wallet), taker fills through the router,
///         and tokens move maker -> taker / taker -> maker atomically. Also proves the live router
///         invokes an Extruction target on both quote and swap paths, which MandateQuoter relies on.
/// @dev Skipped when the chain's RPC env var is unset, so `forge test` works offline.
contract AquaFillForkTest is Test {
    uint256 internal constant LIQ_A = 1_000_000e18;
    uint256 internal constant LIQ_B = 500_000e18;
    uint256 internal constant SWAP_IN = 1000e18;

    ChainConfig internal cfg;
    IAqua internal aqua;
    ISwapVM internal router;

    TokenMock internal tokenA;
    TokenMock internal tokenB;
    address internal maker = makeAddr("maker");
    AquaTaker internal taker;

    function setUp() public {
        cfg = ChainConfigLib.load(1);
        if (bytes(vm.envOr(cfg.rpcEnv, string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ChainConfigLib.selectFork(cfg);

        aqua = IAqua(cfg.aqua);
        router = ISwapVM(cfg.swapVmRouter);

        tokenA = new TokenMock("Token A", "TKA");
        tokenB = new TokenMock("Token B", "TKB");
        taker = new AquaTaker(aqua, router);

        // Maker keeps custody: it only approves Aqua, which pulls on fill.
        tokenA.mint(maker, LIQ_A);
        tokenB.mint(maker, LIQ_B);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();
    }

    function test_canonicalContractsArePresent() public view {
        assertGt(address(aqua).code.length, 0, "aqua code");
        assertGt(address(router).code.length, 0, "router code");
    }

    function test_xycFill_movesTokensFromMakerWallet() public {
        ISwapVM.Order memory order = _order(AquaProgram.xycSwap());
        bytes32 strategyHash = _ship(order);

        (uint256 quotedIn, uint256 quotedOut) = taker.quote(order, address(tokenA), address(tokenB), SWAP_IN, true);

        tokenA.mint(address(taker), SWAP_IN);
        (uint256 amountIn, uint256 amountOut) = taker.swap(order, address(tokenA), address(tokenB), SWAP_IN, true);

        // Quote and swap agree, and match x*y=k over the shipped balances.
        assertEq(amountIn, quotedIn, "quote/swap amountIn");
        assertEq(amountOut, quotedOut, "quote/swap amountOut");
        assertEq(amountOut, LIQ_B * SWAP_IN / (LIQ_A + SWAP_IN), "xyc amountOut");

        // Real token movement: maker wallet pays B and receives A; taker the reverse.
        assertEq(tokenA.balanceOf(maker), LIQ_A + amountIn, "maker A");
        assertEq(tokenB.balanceOf(maker), LIQ_B - amountOut, "maker B");
        assertEq(tokenA.balanceOf(address(taker)), 0, "taker A");
        assertEq(tokenB.balanceOf(address(taker)), amountOut, "taker B");

        // Aqua virtual balances track the fill.
        (uint256 virtA, uint256 virtB) =
            aqua.safeBalances(maker, address(router), strategyHash, address(tokenA), address(tokenB));
        assertEq(virtA, LIQ_A + amountIn, "virtual A");
        assertEq(virtB, LIQ_B - amountOut, "virtual B");
    }

    function test_extructionTarget_calledOnSwapPathOnly() public {
        ProbeExtruction probe = new ProbeExtruction();
        ISwapVM.Order memory order =
            _order(bytes.concat(AquaProgram.extruction(address(probe), ""), AquaProgram.xycSwap()));
        bytes32 strategyHash = _ship(order);

        // Quote path: router STATICCALLs the target; no state is written.
        taker.quote(order, address(tokenA), address(tokenB), SWAP_IN, true);
        assertEq(probe.swapCalls(), 0, "quote must not write");

        tokenA.mint(address(taker), SWAP_IN);
        taker.swap(order, address(tokenA), address(tokenB), SWAP_IN, true);
        assertEq(probe.swapCalls(), 1, "swap path writes once");

        // The query the target sees identifies the strategy, which MandateQuoter will key state on.
        (bytes32 orderHash, address qMaker, address qTaker, address qIn, address qOut, bool exactIn) = probe.lastQuery();
        assertEq(orderHash, strategyHash, "orderHash == Aqua strategyHash");
        assertEq(qMaker, maker, "maker");
        assertEq(qTaker, address(taker), "taker");
        assertEq(qIn, address(tokenA), "tokenIn");
        assertEq(qOut, address(tokenB), "tokenOut");
        assertTrue(exactIn, "isExactIn");
    }

    /// @dev Aqua-backed order: no signature, balances come from the maker's shipped strategy.
    function _order(bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    /// @dev Ships `order` from the maker. Aqua's strategy hash is keccak256 of the shipped bytes,
    ///      which equals the router's order hash for Aqua orders (keccak256(abi.encode(order))).
    function _ship(ISwapVM.Order memory order) internal returns (bytes32 strategyHash) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = LIQ_A;
        amounts[1] = LIQ_B;

        vm.prank(maker);
        strategyHash = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        assertEq(strategyHash, router.hash(order), "strategyHash == router order hash");
    }
}

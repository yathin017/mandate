// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { MandateModule } from "../../src/module/MandateModule.sol";
import { Mandate, MandateParams } from "../../src/libraries/MandateTypes.sol";
import { ChainConfig, ChainConfigLib } from "../lib/ChainConfig.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title LiveFills
/// @notice Exercises the live Base mandate with real transactions: the deployer (as an EOA taker) buys from and
///         sells to the treasury through the canonical router, then the market maker re-ships and claims fees.
/// @dev Needs >= 30 minutes of pool history since deployment (the anchor halts quotes until then).
///      Dry run: forge script script/live/LiveFills.s.sol --rpc-url $BASE_RPC_URL; add --broadcast to send.
contract LiveFills is Script {
    using stdJson for string;

    uint256 internal constant BUY_USD = 1000e6;
    uint256 internal constant SELL_LAUNCH = 500e18;

    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();
        ChainConfig memory cfg = ChainConfigLib.load(LiveConfig.CHAIN_ID);
        ISwapVM router = ISwapVM(cfg.swapVmRouter);
        MandateModule module = MandateModule(json.readAddress(".module"));
        bytes32 id = json.readBytes32(".mandate");
        address base = json.readAddress(".base");
        address quote = json.readAddress(".quote");

        vm.startBroadcast(LiveConfig.deployerKey());
        for (uint256 i; i < 3; ++i) {
            _swap(router, module, id, quote, base, BUY_USD);
        }
        _swap(router, module, id, base, quote, SELL_LAUNCH);
        vm.stopBroadcast();

        // The market maker's own key: tighten the spread inside the issuer's 0.1%-2% range, then claim fees.
        Mandate memory m = module.getMandate(id);
        MandateParams memory next = m.params;
        next.spreadBps = 30;
        vm.startBroadcast(LiveConfig.mmKey());
        module.reship(id, next);
        (uint256 claimedBase, uint256 claimedQuote) = module.claimFees(id);
        vm.stopBroadcast();
        console.log("MM claimed base / quote (raw):", claimedBase, claimedQuote);
    }

    /// @dev Exact-in swap from the EOA taker with 1% slippage protection and a 10 minute deadline. The router pulls
    ///      tokenIn with transferFrom and pushes it into Aqua (the deployer approved the router at deployment).
    function _swap(
        ISwapVM router,
        MandateModule module,
        bytes32 id,
        address tokenIn,
        address tokenOut,
        uint256 amount
    )
        private
    {
        ISwapVM.Order memory order = module.activeOrder(id);
        address taker = vm.addr(LiveConfig.deployerKey());
        (, uint256 quotedOut,) = router.quote(order, tokenIn, tokenOut, amount, _takerData(taker, 0));
        uint256 minOut = quotedOut * 99 / 100;
        (uint256 amountIn, uint256 amountOut,) =
            router.swap(order, tokenIn, tokenOut, amount, _takerData(taker, minOut));
        console.log("filled in / out (raw):", amountIn, amountOut);
    }

    function _takerData(address taker, uint256 minOut) private view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                threshold: minOut == 0 ? bytes("") : abi.encodePacked(minOut),
                to: address(0),
                // casting to 'uint40' is safe because block timestamps fit in 40 bits for millennia
                // forge-lint: disable-next-line(unsafe-typecast)
                deadline: uint40(block.timestamp + 10 minutes),
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }
}

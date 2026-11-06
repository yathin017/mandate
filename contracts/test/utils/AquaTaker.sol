// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {ISwapVM} from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import {ITakerCallbacks} from "@1inch/swap-vm/src/interfaces/ITakerCallbacks.sol";
import {TakerTraitsLib} from "@1inch/swap-vm/src/libs/TakerTraits.sol";

/// @title AquaTaker
/// @notice Test taker for Aqua strategies. Pays `tokenIn` by pushing it into the maker's Aqua
///         balance from `preTransferInCallback`, which is how the router expects Aqua takers to pay.
contract AquaTaker is ITakerCallbacks {
    IAqua public immutable AQUA;
    ISwapVM public immutable ROUTER;

    error OnlyRouter();

    constructor(IAqua aqua, ISwapVM router) {
        AQUA = aqua;
        ROUTER = router;
    }

    /// @notice Taker traits for a plain swap: no threshold, Aqua push in the pre-transfer-in callback.
    function takerData(bool isExactIn) public view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: false,
                threshold: "",
                to: address(0),
                deadline: 0,
                hasPreTransferInCallback: true,
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

    function quote(
        ISwapVM.Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bool isExactIn
    )
        external
        view
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) = ROUTER.quote(order, tokenIn, tokenOut, amount, takerData(isExactIn));
    }

    function swap(
        ISwapVM.Order calldata order,
        address tokenIn,
        address tokenOut,
        uint256 amount,
        bool isExactIn
    )
        external
        returns (uint256 amountIn, uint256 amountOut)
    {
        (amountIn, amountOut,) = ROUTER.swap(order, tokenIn, tokenOut, amount, takerData(isExactIn));
    }

    /// @inheritdoc ITakerCallbacks
    function preTransferInCallback(
        address maker,
        address, /* taker */
        address tokenIn,
        address, /* tokenOut */
        uint256 amountIn,
        uint256, /* amountOut */
        bytes32 orderHash,
        bytes calldata /* takerData */
    )
        external
    {
        require(msg.sender == address(ROUTER), OnlyRouter());
        IERC20(tokenIn).approve(address(AQUA), amountIn);
        AQUA.push(maker, address(ROUTER), orderHash, tokenIn, amountIn);
    }

    /// @inheritdoc ITakerCallbacks
    function preTransferOutCallback(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        bytes32,
        bytes calldata
    )
        external
        view
    {
        require(msg.sender == address(ROUTER), OnlyRouter());
    }
}

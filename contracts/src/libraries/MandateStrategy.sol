// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";

import { AquaProgram } from "./AquaProgram.sol";

/// @title MandateStrategy
/// @notice Builds the one SwapVM order shape a mandate ever ships: `[Salt(nonce), Extruction(quoter, mandateId)]`,
///         Aqua-backed (no signature, no hooks), with the issuer Safe as maker.
/// @dev Aqua strategy hash = keccak256(abi.encode(order)) = router.hash(order) = SwapQuery.orderHash.
library MandateStrategy {
    function order(
        address safe,
        address quoter,
        bytes32 mandateId,
        uint256 nonce
    )
        internal
        pure
        returns (ISwapVM.Order memory)
    {
        bytes memory program =
            bytes.concat(AquaProgram.salt(nonce), AquaProgram.extruction(quoter, abi.encodePacked(mandateId)));
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: safe,
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

    function strategyHash(ISwapVM.Order memory o) internal pure returns (bytes32) {
        return keccak256(abi.encode(o));
    }
}

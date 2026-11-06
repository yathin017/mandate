// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

/// @title ProbeExtruction
/// @notice Pass-through Extruction target used to prove the live router calls our contract on both
///         the quote (static) and swap (stateful) paths. It never changes the swap registers.
/// @dev One function serves IExtruction and IStaticExtruction (same selector). Storage is written
///      only when `isStaticContext` is false, so the router's STATICCALL on the quote path succeeds.
contract ProbeExtruction is IExtruction {
    uint256 public swapCalls;
    SwapQuery public lastQuery;

    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata, /* args */
        bytes calldata /* takerData */
    )
        external
        returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap)
    {
        if (!isStaticContext) {
            swapCalls++;
            lastQuery = query;
        }
        return (nextPC, 0, swap);
    }
}

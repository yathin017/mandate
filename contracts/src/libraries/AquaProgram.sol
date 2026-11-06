// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @title AquaProgram
/// @notice Encodes SwapVM programs for the canonical AquaSwapVMRouter.
/// @dev A program is a sequence of instructions, each `[uint8 opcode][uint8 argsLength][args]`
///      (see swap-vm `ContextLib.runLoop`). Because the length is a uint8, one instruction's args are
///      capped at 255 bytes; for Extruction that leaves 235 bytes after the 20-byte target address.
///
///      Opcode numbers are the indices of the router's opcode table, so they are router-version
///      specific. These match swap-vm v1.0.2 `AquaOpcodes` (the deployed router reports EIP-712
///      version "1.0.2"); `test/unit/AquaProgram.t.sol` re-derives them from that source.
library AquaProgram {
    /// @dev Constant-product swap over the strategy's Aqua balances (`XYCSwap._xycSwapXD`).
    uint8 internal constant OP_XYC_SWAP = 17;
    /// @dev Delegates to an external IExtruction / IStaticExtruction target (`Extruction._extruction`).
    uint8 internal constant OP_EXTRUCTION = 32;

    error InstructionArgsTooLong(uint256 length);

    /// @notice Encodes one instruction.
    function instruction(uint8 opcode, bytes memory args) internal pure returns (bytes memory) {
        require(args.length <= type(uint8).max, InstructionArgsTooLong(args.length));
        return abi.encodePacked(opcode, uint8(args.length), args);
    }

    /// @notice `XYCSwap` instruction; takes no args.
    function xycSwap() internal pure returns (bytes memory) {
        return instruction(OP_XYC_SWAP, "");
    }

    /// @notice `Extruction` instruction calling `target` with `targetArgs`.
    function extruction(address target, bytes memory targetArgs) internal pure returns (bytes memory) {
        return instruction(OP_EXTRUCTION, abi.encodePacked(target, targetArgs));
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";

import {AquaOpcodes} from "@1inch/swap-vm/src/opcodes/AquaOpcodes.sol";
import {XYCSwap} from "@1inch/swap-vm/src/instructions/XYCSwap.sol";
import {Extruction} from "@1inch/swap-vm/src/instructions/Extruction.sol";
import {Program, ProgramBuilder} from "@1inch/swap-vm/test/utils/ProgramBuilder.sol";

import {AquaProgram} from "../../src/libraries/AquaProgram.sol";

/// @dev Exposes swap-vm's real opcode table so we can look up indices by function pointer.
contract AquaOpcodesHarness is AquaOpcodes {
    using ProgramBuilder for Program;

    constructor() AquaOpcodes(address(0)) {}

    function xycSwapIndex() external pure returns (uint8) {
        return ProgramBuilder.init(_opcodes()).findOpcode(XYCSwap._xycSwapXD);
    }

    function extructionIndex() external pure returns (uint8) {
        return ProgramBuilder.init(_opcodes()).findOpcode(Extruction._extruction);
    }
}

/// @notice Guards AquaProgram's hardcoded opcode numbers against the pinned swap-vm source.
contract AquaProgramTest is Test {
    AquaOpcodesHarness internal harness = new AquaOpcodesHarness();

    function test_opcodeNumbersMatchSwapVm() public view {
        assertEq(AquaProgram.OP_XYC_SWAP, harness.xycSwapIndex(), "XYCSwap");
        assertEq(AquaProgram.OP_EXTRUCTION, harness.extructionIndex(), "Extruction");
    }

    function test_extructionEncoding() public pure {
        address target = address(0xBEEF);
        bytes memory program = AquaProgram.extruction(target, hex"0102");
        assertEq(program, abi.encodePacked(uint8(32), uint8(22), target, hex"0102"));
    }

    function test_instruction_revertsWhenArgsTooLong() public {
        vm.expectRevert(abi.encodeWithSelector(AquaProgram.InstructionArgsTooLong.selector, 256));
        this.encode(new bytes(256));
    }

    function encode(bytes memory args) external pure returns (bytes memory) {
        return AquaProgram.instruction(AquaProgram.OP_XYC_SWAP, args);
    }
}

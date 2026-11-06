// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ISafe
/// @notice The two Safe (v1.4.1 ModuleManager) functions MandateModule uses. Kept minimal on purpose.
interface ISafe {
    enum Operation {
        Call,
        DelegateCall
    }

    /// @notice Executes a call from the Safe on behalf of an enabled module.
    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    )
        external
        returns (bool success, bytes memory returnData);

    function isModuleEnabled(address module) external view returns (bool);
}

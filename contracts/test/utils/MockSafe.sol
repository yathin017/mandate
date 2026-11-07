// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { ISafe } from "../../src/interfaces/ISafe.sol";

/// @notice Minimal Safe stand-in: an owner executes arbitrary calls as the Safe, enabled modules use the
///         ModuleManager entry point. Fork tests use the real Safe 1.4.1 instead.
contract MockSafe is ISafe {
    address public immutable owner;
    mapping(address => bool) public modules;

    error NotOwner();
    error NotModule(address caller);

    constructor(address owner_) {
        owner = owner_;
    }

    /// @notice What a signed Safe transaction does: a call from the Safe.
    function execute(address to, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, NotOwner());
        (bool ok, bytes memory ret) = to.call(data);
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 32), mload(ret))
            }
        }
        return ret;
    }

    function enableModule(address module) external {
        require(msg.sender == address(this), NotOwner());
        modules[module] = true;
    }

    function disableModule(address module) external {
        require(msg.sender == address(this), NotOwner());
        modules[module] = false;
    }

    function isModuleEnabled(address module) external view returns (bool) {
        return modules[module];
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes calldata data,
        Operation operation
    )
        external
        returns (bool success, bytes memory returnData)
    {
        // Same message as Safe's GS104.
        require(modules[msg.sender], NotModule(msg.sender));
        require(operation == Operation.Call, "delegatecall not supported in mock");
        (success, returnData) = to.call{ value: value }(data);
    }
}

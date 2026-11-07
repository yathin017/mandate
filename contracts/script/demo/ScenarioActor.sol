// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Local-demo actor that records the actual outcome of an inner contract call.
/// @dev An expected revert is caught so its selector and transaction receipt remain available to the replay.
///      The outer receipt succeeds; it is never presented as a reverted top-level transaction.
contract ScenarioActor {
    address public immutable OWNER = msg.sender;

    event Attempted(uint256 indexed act, uint256 indexed step, address target, bool success, bytes result);

    function attempt(uint256 act, uint256 step, address target, bytes calldata data, bytes4 expectedError) external {
        require(msg.sender == OWNER, "ScenarioActor: owner only");
        (bool success, bytes memory result) = target.call(data);
        if (expectedError == bytes4(0)) {
            require(success, "ScenarioActor: unexpected failure");
        } else {
            // Deliberately inspect only the ABI error selector; retain all bytes in the event.
            // forge-lint: disable-next-line(unsafe-typecast)
            require(!success && bytes4(result) == expectedError, "ScenarioActor: unexpected revert");
        }
        emit Attempted(act, step, target, success, result);
    }
}

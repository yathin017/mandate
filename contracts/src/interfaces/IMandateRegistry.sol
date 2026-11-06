// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Policy, Strategy } from "../libraries/MandateTypes.sol";

/// @title IMandateRegistry
/// @notice Source of truth for policies and strategies. Implemented by MandateModule; the quoter only reads it.
interface IMandateRegistry {
    /// @notice Returns the policy. `status == None` when the id does not exist (never reverts for that).
    function getPolicy(bytes32 policyId) external view returns (Policy memory);

    /// @notice Returns the strategy. `status == None` when the id does not exist (never reverts for that).
    function getStrategy(bytes32 strategyId) external view returns (Strategy memory);
}

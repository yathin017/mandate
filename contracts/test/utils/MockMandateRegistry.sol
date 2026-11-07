// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IMandateRegistry } from "../../src/interfaces/IMandateRegistry.sol";
import { Policy, PolicyConfig, Status, Strategy, StrategyParams } from "../../src/libraries/MandateTypes.sol";

/// @notice Settable stand-in for MandateModule, to test the quoter's rules in isolation. No access control: tests only.
contract MockMandateRegistry is IMandateRegistry {
    mapping(bytes32 => Policy) private _policies;
    mapping(bytes32 => Strategy) private _strategies;

    function setPolicy(bytes32 policyId, Policy memory p) external {
        _policies[policyId] = p;
    }

    function setConfig(bytes32 policyId, PolicyConfig memory c) external {
        _policies[policyId].config = c;
    }

    function setPolicyStatus(bytes32 policyId, Status status) external {
        _policies[policyId].status = status;
    }

    function setStrategy(bytes32 strategyId, Strategy memory s) external {
        _strategies[strategyId] = s;
    }

    function setStrategyStatus(bytes32 strategyId, Status status) external {
        _strategies[strategyId].status = status;
    }

    function setParams(bytes32 strategyId, StrategyParams memory p) external {
        _strategies[strategyId].params = p;
    }

    function setActiveStrategy(bytes32 strategyId, bytes32 strategyHash) external {
        _strategies[strategyId].activeStrategyHash = strategyHash;
    }

    function getPolicy(bytes32 policyId) external view returns (Policy memory) {
        return _policies[policyId];
    }

    function getStrategy(bytes32 strategyId) external view returns (Strategy memory) {
        return _strategies[strategyId];
    }
}

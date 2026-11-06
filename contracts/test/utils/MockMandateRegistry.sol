// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IMandateRegistry} from "../../src/interfaces/IMandateRegistry.sol";
import {Mandate, MandateStatus} from "../../src/libraries/MandateTypes.sol";

/// @notice Settable stand-in for MandateModule until Segment 4. No access control: tests only.
contract MockMandateRegistry is IMandateRegistry {
    mapping(bytes32 => Mandate) private _mandates;

    function set(bytes32 mandateId, Mandate memory m) external {
        _mandates[mandateId] = m;
    }

    function setStatus(bytes32 mandateId, MandateStatus status) external {
        _mandates[mandateId].status = status;
    }

    function setActiveStrategy(bytes32 mandateId, bytes32 strategyHash) external {
        _mandates[mandateId].activeStrategyHash = strategyHash;
    }

    function setEpochCap(bytes32 mandateId, uint256 epochCap) external {
        _mandates[mandateId].params.epochCap = epochCap;
    }

    function getMandate(bytes32 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }
}

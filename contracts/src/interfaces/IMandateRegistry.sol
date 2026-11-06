// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Mandate } from "../libraries/MandateTypes.sol";

/// @title IMandateRegistry
/// @notice Source of truth for mandate terms. Implemented by MandateModule; the quoter only reads it.
interface IMandateRegistry {
    /// @notice Returns the mandate. `status == None` when the id does not exist (never reverts for that).
    function getMandate(bytes32 mandateId) external view returns (Mandate memory);
}

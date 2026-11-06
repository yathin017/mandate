// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { BaseHook } from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import { BaseOracleHook } from "@openzeppelin/uniswap-hooks/oracles/panoptic/BaseOracleHook.sol";

/// @title MandateOracleHook
/// @notice Uniswap v4 hook that records a tick observation before every swap, giving the pool a manipulation-
///         resistant TWAP. Mandate's anchor adapter reads it to refuse treasury fills at off-market prices.
/// @dev All logic is OpenZeppelin's audited BaseOracleHook (uniswap-hooks v1.2.1); this contract only fixes
///      the constructor. Permissions: afterInitialize + beforeSwap, so it must be deployed at an address whose
///      low bits encode exactly those flags (BaseHook validates this in its constructor).
///
///      One hook serves any number of pools; observations are stored per PoolId. Anyone may pay to grow a pool's
///      observation buffer via `increaseObservationCardinalityNext`; a TWAP window needs enough history.
contract MandateOracleHook is BaseOracleHook {
    /// @param poolManager Canonical v4 PoolManager of the chain (from config/chains/<chainId>.json)
    /// @param maxAbsTickDelta Per-block tick cap for the truncated accumulator. Mandate reads the untruncated one,
    ///        so this only affects the secondary series; pass a value large enough to be non-binding if unused.
    constructor(IPoolManager poolManager, int24 maxAbsTickDelta)
        BaseHook(poolManager)
        BaseOracleHook(maxAbsTickDelta)
    { }
}

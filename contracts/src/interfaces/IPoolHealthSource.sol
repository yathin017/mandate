// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

/// @notice What Mandate's market oracle reads from a pool's hook (MandateOracleHook).
interface IPoolHealthSource {
    /// @notice Tick accumulators at `secondsAgos` (OpenZeppelin BaseOracleHook); reverts without enough history.
    function observe(uint32[] calldata secondsAgos, PoolId poolId)
        external
        view
        returns (int56[] memory tickCumulatives, int56[] memory tickCumulativesTruncated);

    /// @notice Active liquidity that predates every add of the hook's settle window (current liquidity otherwise).
    function trustedLiquidity(PoolId poolId) external view returns (uint128);

    /// @notice When the pool was initialised (0 if not through this hook).
    function initializedAt(PoolId poolId) external view returns (uint32);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

/// @title ITickObserver
/// @notice Read surface of a Uniswap v4 oracle hook, matching OpenZeppelin `BaseOracleHook.observe`.
interface ITickObserver {
    /// @return tickCumulatives tick * seconds accumulators at each `secondsAgos`
    /// @return tickCumulativesTruncated same, with per-block tick moves capped by the hook
    function observe(
        uint32[] calldata secondsAgos,
        PoolId poolId
    )
        external
        view
        returns (int56[] memory tickCumulatives, int56[] memory tickCumulativesTruncated);
}

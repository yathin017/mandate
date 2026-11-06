// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { PoolId } from "@uniswap/v4-core/src/types/PoolId.sol";

import { ITickObserver } from "../../src/interfaces/ITickObserver.sol";

/// @notice Returns preset tick accumulators for `[window, 0]` queries.
contract MockTickObserver is ITickObserver {
    int56 public cumulativeThen;
    int56 public cumulativeNow;

    function set(int56 then_, int56 now_) external {
        cumulativeThen = then_;
        cumulativeNow = now_;
    }

    function observe(uint32[] calldata, PoolId) external view returns (int56[] memory c, int56[] memory t) {
        c = new int56[](2);
        c[0] = cumulativeThen;
        c[1] = cumulativeNow;
        t = c;
    }
}

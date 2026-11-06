// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

/// @notice Answers `StateLibrary.getSlot0` reads (via `extsload`) with a preset tick, for any pool.
contract MockSlot0PoolManager {
    bytes32 private _slot0;

    function setTick(int24 tick) external {
        // Layout: [lpFee 24][protocolFee 24][tick 24][sqrtPriceX96 160]; only the tick is read by the anchor.
        _slot0 = bytes32(uint256(uint24(tick)) << 160);
    }

    function extsload(bytes32) external view returns (bytes32) {
        return _slot0;
    }
}

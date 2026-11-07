// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { BaseHook } from "@openzeppelin/uniswap-hooks/base/BaseHook.sol";
import { BaseOracleHook } from "@openzeppelin/uniswap-hooks/oracles/panoptic/BaseOracleHook.sol";

/// @title MandateOracleHook
/// @notice Uniswap v4 hook giving Mandate's market oracle what it needs to judge a pool:
///         - a manipulation-resistant TWAP: a tick observation before every swap (OpenZeppelin's audited
///           BaseOracleHook, unchanged);
///         - the pool's age: when it was initialised;
///         - trusted liquidity: active liquidity that was already there before any add of the last `SETTLE_SECONDS`.
///
///         Trusted liquidity defeats just-in-time depth: liquidity added moments before a treasury fill (and removed
///         right after) does not count until it has stayed `SETTLE_SECONDS`. Removals lower it immediately.
/// @dev Permissions: afterInitialize + beforeAddLiquidity + beforeSwap; the deploy address must encode exactly these
///      flags (BaseHook checks). One hook serves any number of pools; everything is stored per PoolId.
///      Repeated small adds keep the trusted value at the pre-add level for longer; they cannot raise it, and the
///      older liquidity always counts.
///      Implements IPoolHealthSource structurally (`observe` comes from BaseOracleHook), which is how the oracle reads it.
contract MandateOracleHook is BaseOracleHook {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    struct LiquidityState {
        uint32 initializedAt;
        uint32 lastAddAt;
        /// @dev Lowest active liquidity seen just before an add within the current settle window.
        uint128 liquidityBeforeAdds;
    }

    /// @notice How long added liquidity must stay before it counts as trusted (deploy-time choice).
    uint32 public immutable SETTLE_SECONDS;

    mapping(PoolId poolId => LiquidityState) public liquidityStateById;

    /// @param poolManager Canonical v4 PoolManager of the chain (from config/chains/<chainId>.json)
    /// @param maxAbsTickDelta Per-block tick cap for the truncated accumulator. Mandate reads the untruncated one,
    ///        so this only affects the secondary series; pass a value large enough to be non-binding if unused.
    /// @param settleSeconds Seconds an add must age before its liquidity is trusted
    constructor(IPoolManager poolManager, int24 maxAbsTickDelta, uint32 settleSeconds)
        BaseHook(poolManager)
        BaseOracleHook(maxAbsTickDelta)
    {
        SETTLE_SECONDS = settleSeconds;
    }

    function getHookPermissions() public pure override returns (Hooks.Permissions memory permissions) {
        permissions = super.getHookPermissions();
        permissions.beforeAddLiquidity = true;
    }

    function _afterInitialize(address sender, PoolKey calldata key, uint160 sqrtPriceX96, int24 tick)
        internal
        override
        returns (bytes4)
    {
        liquidityStateById[key.toId()].initializedAt = uint32(block.timestamp);
        return super._afterInitialize(sender, key, sqrtPriceX96, tick);
    }

    function _beforeAddLiquidity(address, PoolKey calldata key, ModifyLiquidityParams calldata, bytes calldata)
        internal
        override
        returns (bytes4)
    {
        PoolId id = key.toId();
        LiquidityState storage s = liquidityStateById[id];
        uint128 current = poolManager.getLiquidity(id);
        // A fresh window starts from the liquidity just before this add; inside a window keep the lowest such value.
        if (block.timestamp - s.lastAddAt >= SETTLE_SECONDS || current < s.liquidityBeforeAdds) {
            s.liquidityBeforeAdds = current;
        }
        s.lastAddAt = uint32(block.timestamp);
        return this.beforeAddLiquidity.selector;
    }

    /// @notice Active liquidity that predates every add of the current settle window (current liquidity otherwise).
    function trustedLiquidity(PoolId id) external view returns (uint128) {
        LiquidityState memory s = liquidityStateById[id];
        uint128 current = poolManager.getLiquidity(id);
        if (block.timestamp - s.lastAddAt >= SETTLE_SECONDS) return current;
        return current < s.liquidityBeforeAdds ? current : s.liquidityBeforeAdds;
    }

    /// @notice When the pool was initialised (0 if it was not initialised with this hook).
    function initializedAt(PoolId id) external view returns (uint32) {
        return liquidityStateById[id].initializedAt;
    }
}

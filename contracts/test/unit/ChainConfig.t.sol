// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

/// @notice Every chain config file must parse and contain no zero addresses.
contract ChainConfigTest is Test {
    function test_load_mainnet() public view {
        ChainConfig memory cfg = ChainConfigLib.load(1);

        assertEq(cfg.chainId, 1);
        assertEq(cfg.rpcEnv, "MAINNET_RPC_URL");
        assertGt(cfg.forkBlock, 0);

        assertTrue(cfg.aqua != address(0), "aqua");
        assertTrue(cfg.swapVmRouter != address(0), "swapVmRouter");
        assertTrue(cfg.v4PoolManager != address(0), "v4PoolManager");
        assertTrue(cfg.v4StateView != address(0), "v4StateView");
        assertTrue(cfg.safeSingletonL2 != address(0), "safeSingletonL2");
        assertTrue(cfg.safeProxyFactory != address(0), "safeProxyFactory");
        assertTrue(cfg.weth != address(0), "weth");
        assertTrue(cfg.usdc != address(0), "usdc");
    }

    function test_load_revertsForUnknownChain() public {
        vm.expectRevert();
        this.loadExternal(999_999);
    }

    /// @dev External wrapper so `expectRevert` can catch the cheatcode failure.
    function loadExternal(uint256 chainId) external view returns (ChainConfig memory) {
        return ChainConfigLib.load(chainId);
    }
}

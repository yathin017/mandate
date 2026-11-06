// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {stdJson} from "forge-std/StdJson.sol";

/// @notice External (not ours) addresses and fork settings for one chain.
/// @dev Mirrors `config/chains/<chainId>.json`. Add a field here and in every chain file together.
struct ChainConfig {
    uint256 chainId;
    string name;
    /// @dev Name of the env var holding this chain's RPC URL (never the URL itself).
    string rpcEnv;
    /// @dev Block every fork of this chain is pinned to, for deterministic tests and demos.
    uint256 forkBlock;
    // 1inch Aqua + SwapVM
    address aqua;
    address swapVmRouter;
    // Uniswap v4
    address v4PoolManager;
    address v4StateView;
    // Safe v1.4.1
    address safeSingletonL2;
    address safeProxyFactory;
    // Tokens
    address weth;
    address usdc;
}

/// @title ChainConfigLib
/// @notice Loads per-chain config from `config/chains/<chainId>.json` so no chain-specific address is
///         hardcoded in Solidity. Supporting a new chain means adding a JSON file, not changing code.
/// @dev Script/test only: relies on Foundry cheatcodes and `fs_permissions` in foundry.toml.
library ChainConfigLib {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    /// @notice Loads config for the chain the script/test is currently running on.
    function load() internal view returns (ChainConfig memory) {
        return load(block.chainid);
    }

    /// @notice Loads config for an explicit chain id (e.g. before a fork is selected).
    function load(uint256 chainId) internal view returns (ChainConfig memory cfg) {
        string memory json = VM.readFile(path(chainId));

        cfg.chainId = json.readUint(".chainId");
        require(cfg.chainId == chainId, "ChainConfig: chainId mismatch");
        cfg.name = json.readString(".name");
        cfg.rpcEnv = json.readString(".rpcEnv");
        cfg.forkBlock = json.readUint(".forkBlock");

        cfg.aqua = json.readAddress(".aqua.aqua");
        cfg.swapVmRouter = json.readAddress(".aqua.swapVmRouter");

        cfg.v4PoolManager = json.readAddress(".uniswapV4.poolManager");
        cfg.v4StateView = json.readAddress(".uniswapV4.stateView");

        cfg.safeSingletonL2 = json.readAddress(".safe.singletonL2");
        cfg.safeProxyFactory = json.readAddress(".safe.proxyFactory");

        cfg.weth = json.readAddress(".tokens.weth");
        cfg.usdc = json.readAddress(".tokens.usdc");
    }

    /// @notice Absolute path of a chain's config file. `projectRoot()` is the Foundry root (`contracts/`).
    function path(uint256 chainId) internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/../config/chains/", VM.toString(chainId), ".json");
    }

    /// @notice Selects a fork of `cfg`'s chain at its pinned block using the RPC from `cfg.rpcEnv`.
    function selectFork(ChainConfig memory cfg) internal returns (uint256 forkId) {
        forkId = VM.createSelectFork(VM.envString(cfg.rpcEnv), cfg.forkBlock);
    }
}

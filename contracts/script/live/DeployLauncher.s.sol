// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import { AnchorLauncher } from "../../src/anchor/AnchorLauncher.sol";
import { MandateOracleHook } from "../../src/hook/MandateOracleHook.sol";
import { ChainConfig, ChainConfigLib } from "../lib/ChainConfig.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title DeployLauncher
/// @notice Deploys AnchorLauncher on Base, bound to the canonical PoolManager and the live MandateOracleHook, and
///         records it as `anchorLauncher` in deployments/8453.json (only when broadcasting).
/// @dev Dry run: forge script script/live/DeployLauncher.s.sol --rpc-url $BASE_RPC_URL; add --broadcast to send.
contract DeployLauncher is Script {
    using stdJson for string;

    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();
        ChainConfig memory cfg = ChainConfigLib.load(LiveConfig.CHAIN_ID);
        MandateOracleHook hook = MandateOracleHook(json.readAddress(".hook"));

        vm.startBroadcast(LiveConfig.deployerKey());
        AnchorLauncher launcher = new AnchorLauncher(IPoolManager(cfg.v4PoolManager), hook);
        vm.stopBroadcast();
        console.log("AnchorLauncher:", address(launcher));

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.serializeJson("manifest", json);
            vm.writeJson(vm.serializeAddress("manifest", "anchorLauncher", address(launcher)), LiveConfig.path());
        }
    }
}

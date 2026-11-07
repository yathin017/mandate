// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";

import { TokenFactory } from "../../src/launch/TokenFactory.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title DeployTokenFactory
/// @notice Deploys TokenFactory on Base and records it as `tokenFactory` in deployments/8453.json (only when
///         broadcasting). The factory has no owner or settings, so this is its whole setup.
/// @dev Dry run: forge script script/live/DeployTokenFactory.s.sol --rpc-url $BASE_RPC_URL; add --broadcast to send.
///      Restart the Base worker right after, so launches from the deployment block on are indexed.
contract DeployTokenFactory is Script {
    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();

        vm.startBroadcast(LiveConfig.deployerKey());
        TokenFactory factory = new TokenFactory();
        vm.stopBroadcast();
        console.log("TokenFactory:", address(factory));

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            vm.serializeJson("manifest", json);
            vm.writeJson(vm.serializeAddress("manifest", "tokenFactory", address(factory)), LiveConfig.path());
        }
    }
}

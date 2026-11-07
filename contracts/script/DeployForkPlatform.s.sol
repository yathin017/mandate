// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import { AnchorLauncher } from "../src/anchor/AnchorLauncher.sol";
import { MandateOracleHook } from "../src/hook/MandateOracleHook.sol";
import { TokenFactory } from "../src/launch/TokenFactory.sol";
import { ChainConfig, ChainConfigLib } from "./lib/ChainConfig.sol";
import { DemoConfig } from "./lib/DemoConfig.sol";

/// @title DeployForkPlatform
/// @notice Adds the self-serve pieces to a running local demo fork: an AnchorLauncher bound to the fork's oracle hook
///         and a TokenFactory. The recorded demo (`pnpm replay:serve`) does not deploy them, so the launch wizard needs
///         this to create pools and tokens locally. Prints the env lines for the web app and the indexer.
/// @dev Local chain 31337 only. Run with `pnpm fork:platform` while the demo fork is up; re-running deploys new copies.
contract DeployForkPlatform is Script {
    using stdJson for string;

    function run() external {
        DemoConfig.guard();
        string memory json = DemoConfig.manifest();
        ChainConfig memory cfg = ChainConfigLib.load(1);
        MandateOracleHook hook = MandateOracleHook(json.readAddress(".hook"));
        require(address(hook).code.length > 0, "Fork: deploy the demo first (pnpm replay:serve)");

        vm.startBroadcast(DemoConfig.deployer());
        AnchorLauncher launcher = new AnchorLauncher(IPoolManager(cfg.v4PoolManager), hook);
        TokenFactory factory = new TokenFactory();
        vm.stopBroadcast();

        console.log("Add to apps/web/.env.local, then restart pnpm web:dev:");
        console.log(string.concat("VITE_ANCHOR_LAUNCHER=", vm.toString(address(launcher))));
        console.log(string.concat("VITE_TOKEN_FACTORY=", vm.toString(address(factory))));
        console.log("Add to .env (or the worker's environment), then restart pnpm indexer:worker:");
        console.log(string.concat("INDEXER_TOKEN_FACTORY=", vm.toString(address(factory))));
    }
}

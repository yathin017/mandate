// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import { MandateModule } from "../src/module/MandateModule.sol";
import { MandateOracleHook } from "../src/hook/MandateOracleHook.sol";
import { UniswapV4MarketOracle } from "../src/anchor/UniswapV4MarketOracle.sol";
import { MockERC20 } from "../src/mocks/MockERC20.sol";
import { AquaTaker } from "../src/mocks/AquaTaker.sol";
import { ChainConfig, ChainConfigLib } from "./lib/ChainConfig.sol";
import { ISafeAccount, SafeTransactions } from "./lib/SafeTransactions.sol";
import { DemoConfig } from "./lib/DemoConfig.sol";
import { ScenarioActor } from "./demo/ScenarioActor.sol";
import { DemoState } from "./demo/DemoState.sol";

/// @notice Broadcasts real deployments to a local mainnet fork; never uses etch, prank or warp.
/// @dev All token inventory is SYNTHETIC. deployments/1.json describes a fork OF chain 1, not mainnet deployment.
contract DeployFork is Script {
    function run() external {
        DemoConfig.guard();
        ChainConfig memory cfg = ChainConfigLib.load(1);
        require(
            cfg.aqua.code.length > 0 && cfg.swapVmRouter.code.length > 0 && cfg.v4PoolManager.code.length > 0,
            "Demo: canonical venue missing"
        );
        address deployer = DemoConfig.deployer();
        vm.startBroadcast(deployer);
        MockERC20 base = new MockERC20("Synthetic Launch Token", "LAUNCH", 18);
        MockERC20 quote = new MockERC20("Synthetic USD Coin", "sUSDC", 6);
        MandateModule module = new MandateModule(cfg.swapVmRouter, IAqua(cfg.aqua));

        // Foundry routes broadcast CREATE2 deployments through the standard deterministic deployer proxy.
        (address predicted, bytes32 salt) = HookMiner.find(
            0x4e59b44847b379578588920cA78FbF26c0B4956C,
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG,
            type(MandateOracleHook).creationCode,
            abi.encode(IPoolManager(cfg.v4PoolManager), TickMath.MAX_TICK, DemoConfig.SETTLE_SECONDS)
        );
        MandateOracleHook hook = new MandateOracleHook{ salt: salt }(
            IPoolManager(cfg.v4PoolManager), TickMath.MAX_TICK, DemoConfig.SETTLE_SECONDS
        );
        require(address(hook) == predicted, "Demo: CREATE2 address mismatch");
        PoolSwapTest swapRouter = new PoolSwapTest(IPoolManager(cfg.v4PoolManager));
        PoolModifyLiquidityTest liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(cfg.v4PoolManager));
        ScenarioActor mm = new ScenarioActor();
        ScenarioActor traditionalMm = new ScenarioActor();
        AquaTaker taker = new AquaTaker(IAqua(cfg.aqua), ISwapVM(cfg.swapVmRouter));
        UniswapV4MarketOracle anchor = new UniswapV4MarketOracle(
            IPoolManager(cfg.v4PoolManager),
            DemoConfig.pool(address(base), address(quote), address(hook), false),
            address(base),
            address(quote)
        );
        UniswapV4MarketOracle traditionalAnchor = new UniswapV4MarketOracle(
            IPoolManager(cfg.v4PoolManager),
            DemoConfig.pool(address(base), address(quote), address(hook), true),
            address(base),
            address(quote)
        );
        DemoState state = new DemoState(module, anchor, traditionalAnchor, address(traditionalMm));

        uint256[] memory keys = DemoConfig.keys();
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(keys[0]);
        owners[1] = vm.addr(keys[1]);
        address[3] memory safes;
        for (uint256 i; i < 3; ++i) {
            safes[i] = address(SafeTransactions.create(cfg.safeSingletonL2, cfg.safeProxyFactory, owners, 2, i + 1));
            base.mint(safes[i], i == 1 ? DemoConfig.BURST_ALLOTMENT : DemoConfig.ALLOTMENT);
            quote.mint(safes[i], i == 1 ? DemoConfig.BURST_QUOTE : DemoConfig.QUOTE);
        }
        ISafeAccount traditionalSafe = SafeTransactions.create(cfg.safeSingletonL2, cfg.safeProxyFactory, owners, 2, 4);
        base.mint(address(traditionalSafe), DemoConfig.ALLOTMENT);
        base.mint(deployer, 1e30);
        quote.mint(deployer, 1e30);
        base.mint(address(mm), 1e30);
        quote.mint(address(mm), 1e30);
        base.mint(address(taker), 100_000e18);
        quote.mint(address(taker), 100_000_000e6);
        vm.stopBroadcast();

        string memory obj = "deployment";
        vm.serializeString(obj, "environment", "local-mainnet-fork");
        vm.serializeUint(obj, "chainId", 31_337);
        vm.serializeUint(obj, "sourceChainId", 1);
        vm.serializeUint(obj, "forkBlock", cfg.forkBlock);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "base", address(base));
        vm.serializeAddress(obj, "quote", address(quote));
        vm.serializeAddress(obj, "module", address(module));
        vm.serializeAddress(obj, "quoter", address(module.QUOTER()));
        vm.serializeAddress(obj, "hook", address(hook));
        vm.serializeAddress(obj, "anchor", address(anchor));
        vm.serializeAddress(obj, "traditionalAnchor", address(traditionalAnchor));
        vm.serializeAddress(obj, "swapRouter", address(swapRouter));
        vm.serializeAddress(obj, "liquidityRouter", address(liquidityRouter));
        vm.serializeAddress(obj, "mm", address(mm));
        vm.serializeAddress(obj, "traditionalMm", address(traditionalMm));
        vm.serializeAddress(obj, "taker", address(taker));
        vm.serializeAddress(obj, "stateReader", address(state));
        vm.serializeAddress(obj, "safe1", safes[0]);
        vm.serializeAddress(obj, "safe2", safes[1]);
        vm.serializeAddress(obj, "traditionalSafe", address(traditionalSafe));
        string memory json = vm.serializeAddress(obj, "safe3", safes[2]);
        vm.writeJson(json, DemoConfig.path());
    }
}

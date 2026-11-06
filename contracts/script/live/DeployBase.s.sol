// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { Hooks } from "@uniswap/v4-core/src/libraries/Hooks.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolIdLibrary, PoolKey } from "@uniswap/v4-core/src/types/PoolId.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { HookMiner } from "@uniswap/v4-periphery/src/utils/HookMiner.sol";

import { MandateModule } from "../../src/module/MandateModule.sol";
import { MandateOracleHook } from "../../src/hook/MandateOracleHook.sol";
import { AnchorLauncher } from "../../src/anchor/AnchorLauncher.sol";
import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";
import { ChainConfig, ChainConfigLib } from "../lib/ChainConfig.sol";
import { DemoConfig } from "../lib/DemoConfig.sol";
import { ISafeAccount, SafeTransactions } from "../lib/SafeTransactions.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title DeployBase
/// @notice Deploys Mandate v2 to Base mainnet: module + quoter, oracle hook and AnchorLauncher (the platform), plus a
///         demo pair with mock tokens: a seeded v4 anchor pool, a 2-of-2 issuer Safe, its treasury policy and one
///         market-making strategy whose market maker is a separate key. The TokenFactory is kept from the previous
///         manifest (it does not depend on the module).
/// @dev Dry run:  forge script script/live/DeployBase.s.sol --rpc-url $BASE_RPC_URL
///      Broadcast: add --broadcast. The manifest is written only when broadcasting.
///      Every issuer action goes through the Safe with both owners' EIP-712 signatures; nothing is impersonated.
contract DeployBase is Script {
    using PoolIdLibrary for PoolKey;
    using stdJson for string;

    struct Deployed {
        MockERC20 base;
        MockERC20 quote;
        MandateModule module;
        MandateOracleHook hook;
        PoolSwapTest swapRouter;
        PoolModifyLiquidityTest liquidityRouter;
        AnchorLauncher launcher;
        UniswapV4MarketOracle anchor;
        ISafeAccount safe;
        bytes32 policyId;
        bytes32 strategyId;
    }

    function run() external {
        LiveConfig.guard();
        ChainConfig memory cfg = ChainConfigLib.load(LiveConfig.CHAIN_ID);
        require(
            cfg.aqua.code.length > 0 && cfg.swapVmRouter.code.length > 0 && cfg.v4PoolManager.code.length > 0,
            "Live: venue missing"
        );

        address deployer = vm.addr(LiveConfig.deployerKey());
        address owner2 = vm.addr(LiveConfig.owner2Key());
        address mm = vm.addr(LiveConfig.mmKey());
        uint256 startBlock = block.number;

        vm.startBroadcast(LiveConfig.deployerKey());
        Deployed memory d = _deployContracts(cfg);
        _seedPool(cfg, d);
        d.safe = _createSafe(cfg, d, deployer, owner2);
        (d.policyId, d.strategyId) = _createPolicy(d, mm);

        // Gas for the second owner (approvals in the web app) and the MM (reship, pause, claim).
        payable(owner2).transfer(LiveConfig.GAS_TOPUP);
        payable(mm).transfer(LiveConfig.GAS_TOPUP);
        // The deployer is the demo taker: it pays the router, which pushes into Aqua (EOA settlement).
        d.base.approve(cfg.swapVmRouter, type(uint256).max);
        d.quote.approve(cfg.swapVmRouter, type(uint256).max);
        vm.stopBroadcast();

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) _writeManifest(d, deployer, owner2, mm, startBlock);
    }

    function _deployContracts(ChainConfig memory cfg) private returns (Deployed memory d) {
        d.base = new MockERC20("Mandate Demo Launch", "mLAUNCH", 18);
        d.quote = new MockERC20("Mandate Demo Dollar", "mUSD", 6);
        d.module = new MandateModule(cfg.swapVmRouter, IAqua(cfg.aqua));

        // Broadcast CREATE2 goes through the standard deterministic deployer; the salt encodes the hook flags.
        (address predicted, bytes32 salt) = HookMiner.find(
            0x4e59b44847b379578588920cA78FbF26c0B4956C,
            Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_ADD_LIQUIDITY_FLAG | Hooks.BEFORE_SWAP_FLAG,
            type(MandateOracleHook).creationCode,
            abi.encode(IPoolManager(cfg.v4PoolManager), TickMath.MAX_TICK, LiveConfig.SETTLE_SECONDS)
        );
        d.hook = new MandateOracleHook{ salt: salt }(
            IPoolManager(cfg.v4PoolManager), TickMath.MAX_TICK, LiveConfig.SETTLE_SECONDS
        );
        require(address(d.hook) == predicted, "Live: CREATE2 address mismatch");

        d.swapRouter = new PoolSwapTest(IPoolManager(cfg.v4PoolManager));
        d.liquidityRouter = new PoolModifyLiquidityTest(IPoolManager(cfg.v4PoolManager));
        d.launcher = new AnchorLauncher(IPoolManager(cfg.v4PoolManager), d.hook);
    }

    /// @dev The launcher creates the pool and its market oracle. Real-time history accrues from here: fills wait for the
    ///      policy's minimum pool age (1 hour in the demo policy) and for the liquidity to settle.
    function _seedPool(ChainConfig memory, Deployed memory d) private {
        address deployer = vm.addr(LiveConfig.deployerKey());
        d.base.mint(deployer, 1e30);
        d.quote.mint(deployer, 1e30);
        d.base.approve(address(d.liquidityRouter), type(uint256).max);
        d.quote.approve(address(d.liquidityRouter), type(uint256).max);
        d.base.approve(address(d.swapRouter), type(uint256).max);
        d.quote.approve(address(d.swapRouter), type(uint256).max);

        (d.anchor,,) = d.launcher.launch(address(d.base), address(d.quote), LiveConfig.PRICE);
        PoolKey memory key = d.launcher.poolKeyFor(address(d.base), address(d.quote));
        d.liquidityRouter
            .modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: TickMath.minUsableTick(key.tickSpacing),
                    tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                    liquidityDelta: LiveConfig.POOL_LIQUIDITY,
                    salt: 0
                }),
                ""
            );
        // A first swap activates the grown observation buffer.
        d.swapRouter
            .swap(
                key,
                SwapParams({
                    zeroForOne: address(d.base) > address(d.quote),
                    amountSpecified: -1e29,
                    sqrtPriceLimitX96: DemoConfig.sqrtPrice(address(d.base), address(d.quote), LiveConfig.PRICE + 1e20)
                }),
                PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                ""
            );
    }

    function _createSafe(
        ChainConfig memory cfg,
        Deployed memory d,
        address deployer,
        address owner2
    )
        private
        returns (ISafeAccount safe)
    {
        address[] memory owners = new address[](2);
        owners[0] = deployer;
        owners[1] = owner2;
        // Timestamp salt: re-running the script never collides with an earlier Safe.
        safe = SafeTransactions.create(cfg.safeSingletonL2, cfg.safeProxyFactory, owners, 2, block.timestamp);
        d.base.mint(address(safe), LiveConfig.ALLOTMENT);
        d.quote.mint(address(safe), LiveConfig.BUYBACK);
        require(
            SafeTransactions.execute(
                safe,
                address(safe),
                abi.encodeCall(ISafeAccount.enableModule, (address(d.module))),
                LiveConfig.sortedOwnerKeys()
            ),
            "Live: enableModule failed"
        );
    }

    function _createPolicy(Deployed memory d, address mm) private returns (bytes32 policyId, bytes32 strategyId) {
        bytes memory create = abi.encodeCall(
            MandateModule.createPolicy, (address(d.base), address(d.quote), LiveConfig.policy(address(d.anchor)))
        );
        require(
            SafeTransactions.execute(d.safe, address(d.module), create, LiveConfig.sortedOwnerKeys()),
            "Live: createPolicy failed"
        );
        policyId = d.module.activePolicyOf(address(d.safe), address(d.base));
        bytes memory add = abi.encodeCall(
            MandateModule.addStrategy,
            (policyId, mm, LiveConfig.kind(), LiveConfig.strategyBounds(), LiveConfig.params())
        );
        require(
            SafeTransactions.execute(d.safe, address(d.module), add, LiveConfig.sortedOwnerKeys()),
            "Live: addStrategy failed"
        );
        strategyId = d.module.strategiesOf(policyId)[0];
    }

    function _writeManifest(
        Deployed memory d,
        address deployer,
        address owner2,
        address mm,
        uint256 startBlock
    )
        private
    {
        string memory obj = "live";
        vm.serializeString(obj, "environment", "live");
        vm.serializeUint(obj, "chainId", LiveConfig.CHAIN_ID);
        vm.serializeUint(obj, "sourceChainId", LiveConfig.CHAIN_ID);
        vm.serializeUint(obj, "deployBlock", startBlock);
        vm.serializeBool(obj, "syntheticTokens", true);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "owner2", owner2);
        vm.serializeAddress(obj, "mm", mm);
        vm.serializeAddress(obj, "base", address(d.base));
        vm.serializeAddress(obj, "quote", address(d.quote));
        vm.serializeAddress(obj, "module", address(d.module));
        vm.serializeAddress(obj, "quoter", address(d.module.QUOTER()));
        vm.serializeAddress(obj, "hook", address(d.hook));
        vm.serializeAddress(obj, "anchor", address(d.anchor));
        vm.serializeAddress(obj, "anchorLauncher", address(d.launcher));
        address factory = _previousTokenFactory();
        if (factory != address(0)) vm.serializeAddress(obj, "tokenFactory", factory);
        vm.serializeAddress(obj, "swapRouter", address(d.swapRouter));
        vm.serializeAddress(obj, "liquidityRouter", address(d.liquidityRouter));
        vm.serializeAddress(obj, "safe", address(d.safe));
        vm.serializeBytes32(obj, "policy", d.policyId);
        string memory json = vm.serializeBytes32(obj, "strategy", d.strategyId);
        vm.writeJson(json, LiveConfig.path());
    }

    /// @dev The TokenFactory is independent of the module, so a redeploy keeps the one already recorded: in the
    ///      current manifest, or in the archived v1 manifest when this is the first v2 deployment.
    function _previousTokenFactory() private view returns (address) {
        string[2] memory paths =
            [LiveConfig.path(), string.concat(vm.projectRoot(), "/../deployments/archive/8453-v1.json")];
        for (uint256 i; i < paths.length; ++i) {
            if (!vm.exists(paths[i])) continue;
            string memory previous = vm.readFile(paths[i]);
            if (previous.keyExists(".tokenFactory")) return previous.readAddress(".tokenFactory");
        }
        return address(0);
    }
}

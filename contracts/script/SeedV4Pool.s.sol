// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolIdLibrary, PoolKey } from "@uniswap/v4-core/src/types/PoolId.sol";
import { ModifyLiquidityParams, SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MandateOracleHook } from "../src/hook/MandateOracleHook.sol";
import { ChainConfig, ChainConfigLib } from "./lib/ChainConfig.sol";
import { DemoConfig } from "./lib/DemoConfig.sol";

/// @notice Creates separate anchor and traditional-loan pools with synthetic liquidity on canonical v4.
contract SeedV4Pool is Script {
    using stdJson for string;
    using PoolIdLibrary for PoolKey;

    function run() external {
        DemoConfig.guard();
        string memory json = DemoConfig.manifest();
        ChainConfig memory cfg = ChainConfigLib.load(1);
        address base = json.readAddress(".base");
        address quote = json.readAddress(".quote");
        address hook = json.readAddress(".hook");
        PoolModifyLiquidityTest liquidity = PoolModifyLiquidityTest(json.readAddress(".liquidityRouter"));
        PoolSwapTest swap = PoolSwapTest(json.readAddress(".swapRouter"));
        vm.startBroadcast(DemoConfig.deployer());
        IERC20(base).approve(address(liquidity), type(uint256).max);
        IERC20(quote).approve(address(liquidity), type(uint256).max);
        IERC20(base).approve(address(swap), type(uint256).max);
        IERC20(quote).approve(address(swap), type(uint256).max);
        for (uint256 i; i < 2; ++i) {
            PoolKey memory key = DemoConfig.pool(base, quote, hook, i == 1);
            IPoolManager(cfg.v4PoolManager).initialize(key, DemoConfig.sqrtPrice(base, quote, DemoConfig.PRICE));
            MandateOracleHook(hook).increaseObservationCardinalityNext(300, key.toId());
            liquidity.modifyLiquidity(
                key,
                ModifyLiquidityParams({
                    tickLower: TickMath.minUsableTick(key.tickSpacing),
                    tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                    liquidityDelta: 6e17,
                    salt: 0
                }),
                ""
            );
        }
        // The next swap activates the grown buffer. The Node runner then mines an hour of SYNTHETIC history.
        PoolKey memory anchorKey = DemoConfig.pool(base, quote, hook, false);
        bool zeroForOne = base > quote;
        swap.swap(
            anchorKey,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -1e29,
                sqrtPriceLimitX96: DemoConfig.sqrtPrice(base, quote, DemoConfig.PRICE + 1e20)
            }),
            PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
            ""
        );
        vm.stopBroadcast();
    }
}

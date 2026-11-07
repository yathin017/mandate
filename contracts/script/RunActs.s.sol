// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { SwapParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolSwapTest } from "@uniswap/v4-core/src/test/PoolSwapTest.sol";
import { MandateModule } from "../src/module/MandateModule.sol";
import { StrategyKind, StrategyParams } from "../src/libraries/MandateTypes.sol";
import { IMandateModule } from "../src/interfaces/IMandateModule.sol";
import { IMandateQuoter } from "../src/interfaces/IMandateQuoter.sol";
import { AquaTaker } from "../src/mocks/AquaTaker.sol";
import { ISafe } from "../src/interfaces/ISafe.sol";
import { ISafeAccount, SafeTransactions } from "./lib/SafeTransactions.sol";
import { DemoConfig } from "./lib/DemoConfig.sol";
import { ScenarioActor } from "./demo/ScenarioActor.sol";

/// @notice Broadcasts Acts 1–3 against v2 policies and strategies. The exporter advances local-node time between the
///         TWAP phases.
/// @dev Each ScenarioActor call checks its expected result onchain and emits the real return/revert data.
contract RunActs is Script {
    using stdJson for string;
    using SafeTransactions for ISafeAccount;

    MandateModule internal module;
    AquaTaker internal taker;
    ScenarioActor internal mm;
    ScenarioActor internal traditionalMm;
    address internal base;
    address internal quote;
    address internal hook;
    PoolSwapTest internal swapRouter;
    ISafeAccount[3] internal safes;
    /// @dev Each act's Safe has one policy with one market-making strategy; `ids` are the strategy ids.
    bytes32[3] internal policyIds;
    bytes32[3] internal ids;
    string internal json;

    function run(uint256 phase) external {
        DemoConfig.guard();
        _load();
        vm.startBroadcast(DemoConfig.deployer());
        if (phase == 0) _initialize();
        else if (phase == 1) _act1();
        else if (phase == 2) _burst();
        else if (phase == 3) _move(200, 6e23);
        else if (phase == 4) _buy(2, 201, 1000e18, IMandateQuoter.RiskPaused.selector);
        else if (phase == 5) _move(202, DemoConfig.PRICE);
        else if (phase == 6) _buy(2, 203, 1000e18, bytes4(0));
        else if (phase == 7) _move(210, 3e23);
        else if (phase == 8) _buyback(211, IMandateQuoter.QuoteOffMarket.selector);
        else if (phase == 9) _move(212, DemoConfig.PRICE);
        else if (phase == 10) _buyback(213, bytes4(0));
        else if (phase == 11) _act3();
        else revert("Demo: unknown phase");
        vm.stopBroadcast();
    }

    function _load() private {
        json = DemoConfig.manifest();
        module = MandateModule(json.readAddress(".module"));
        require(address(module).code.length > 0, "Demo: deploy first");
        taker = AquaTaker(json.readAddress(".taker"));
        mm = ScenarioActor(json.readAddress(".mm"));
        traditionalMm = ScenarioActor(json.readAddress(".traditionalMm"));
        base = json.readAddress(".base");
        quote = json.readAddress(".quote");
        hook = json.readAddress(".hook");
        swapRouter = PoolSwapTest(json.readAddress(".swapRouter"));
        for (uint256 i; i < 3; ++i) {
            safes[i] = ISafeAccount(json.readAddress(string.concat(".safe", vm.toString(i + 1))));
            policyIds[i] = module.activePolicyOf(address(safes[i]), base);
            if (policyIds[i] != bytes32(0)) ids[i] = module.strategiesOf(policyIds[i])[0];
        }
    }

    function _initialize() private {
        mm.attempt(0, 0, base, abi.encodeCall(IERC20.approve, (address(swapRouter), type(uint256).max)), bytes4(0));
        mm.attempt(0, 1, quote, abi.encodeCall(IERC20.approve, (address(swapRouter), type(uint256).max)), bytes4(0));
        for (uint256 i; i < 3; ++i) {
            require(ids[i] == bytes32(0), "Demo: already initialized");
            require(
                safes[i].execute(
                    address(safes[i]), abi.encodeCall(ISafeAccount.enableModule, (address(module))), DemoConfig.keys()
                ),
                "Demo: enable failed"
            );
            require(
                safes[i].execute(
                    address(module),
                    abi.encodeCall(
                        MandateModule.createPolicy,
                        (base, quote, DemoConfig.policy(json.readAddress(".anchor"), i == 1))
                    ),
                    DemoConfig.keys()
                ),
                "Demo: create policy failed"
            );
            policyIds[i] = module.activePolicyOf(address(safes[i]), base);
            require(
                safes[i].execute(
                    address(module),
                    abi.encodeCall(
                        MandateModule.addStrategy,
                        (
                            policyIds[i],
                            address(mm),
                            StrategyKind.MarketMaking,
                            DemoConfig.strategyBounds(i == 1),
                            DemoConfig.params(i == 1)
                        )
                    ),
                    DemoConfig.keys()
                ),
                "Demo: add strategy failed"
            );
            ids[i] = module.strategiesOf(policyIds[i])[0];
            string memory key = string.concat("act", vm.toString(i + 1));
            vm.serializeBytes32("policies", key, policyIds[i]);
            vm.serializeBytes32("strategies", key, ids[i]);
        }
        ISafeAccount loanSafe = ISafeAccount(json.readAddress(".traditionalSafe"));
        require(
            loanSafe.execute(
                base, abi.encodeCall(IERC20.transfer, (address(traditionalMm), DemoConfig.ALLOTMENT)), DemoConfig.keys()
            ),
            "Demo: loan failed"
        );
        vm.writeJson(vm.serializeBytes32("policies", "act3", policyIds[2]), DemoConfig.path(), ".policies");
        vm.writeJson(vm.serializeBytes32("strategies", "act3", ids[2]), DemoConfig.path(), ".strategies");
        console2.log("Created 3 policies with a strategy each; traditional MM received 10M LAUNCH from its Safe.");
    }

    function _act1() private {
        traditionalMm.attempt(
            1, 0, base, abi.encodeCall(IERC20.approve, (address(swapRouter), type(uint256).max)), bytes4(0)
        );
        PoolKey memory key = DemoConfig.pool(base, quote, hook, true);
        bool zeroForOne = base < quote;
        traditionalMm.attempt(
            1,
            1,
            address(swapRouter),
            abi.encodeCall(
                PoolSwapTest.swap,
                (
                    key,
                    SwapParams({
                        zeroForOne: zeroForOne,
                        amountSpecified: -int256(DemoConfig.ALLOTMENT),
                        sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
                    }),
                    PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                    bytes("")
                )
            ),
            bytes4(0)
        );
        for (uint256 i; i < 6; ++i) {
            _buy(1, 10 + i, 10_000e18, i < 5 ? bytes4(0) : IMandateQuoter.NetSellCapReached.selector);
        }
        console2.log("Act 1: traditional MM sold 10M; Mandate filled 50,000 then blocked.");
    }

    function _burst() private {
        // 150 equal synthetic intents total 134.1M LAUNCH. Not historical FUN transactions or ETH proceeds.
        for (uint256 i; i < 150; ++i) {
            _buy(2, i + 1, 894_000e18, i == 0 ? bytes4(0) : IMandateQuoter.NetSellCapReached.selector);
        }
        console2.log("Act 2: 150 synthetic intents; 894,000 LAUNCH filled, 149 blocked.");
    }

    function _buy(uint256 act, uint256 step, uint256 amount, bytes4 error_) private {
        mm.attempt(
            act,
            step,
            address(taker),
            abi.encodeCall(AquaTaker.swap, (module.activeOrder(ids[act - 1]), quote, base, amount, false)),
            error_
        );
    }

    function _buyback(uint256 step, bytes4 error_) private {
        mm.attempt(
            2,
            step,
            address(taker),
            abi.encodeCall(AquaTaker.swap, (module.activeOrder(ids[1]), base, quote, 1000e18, true)),
            error_
        );
    }

    function _move(uint256 step, uint256 price) private {
        PoolKey memory key = DemoConfig.pool(base, quote, hook, false);
        bool zeroForOne = price < DemoConfig.PRICE ? base < quote : base > quote;
        // Recovery direction depends on which side of the target the previous phase left the pool.
        if (step == 202) zeroForOne = base < quote;
        if (step == 212) zeroForOne = base > quote;
        mm.attempt(
            2,
            step,
            address(swapRouter),
            abi.encodeCall(
                PoolSwapTest.swap,
                (
                    key,
                    SwapParams({
                        zeroForOne: zeroForOne,
                        amountSpecified: -1e29,
                        sqrtPriceLimitX96: DemoConfig.sqrtPrice(base, quote, price)
                    }),
                    PoolSwapTest.TestSettings({ takeClaims: false, settleUsingBurn: false }),
                    bytes("")
                )
            ),
            bytes4(0)
        );
    }

    function _act3() private {
        StrategyParams memory p = module.getStrategy(ids[2]).params;
        p.spreadBps = 30;
        mm.attempt(3, 0, address(module), abi.encodeCall(MandateModule.reship, (ids[2], p)), bytes4(0));
        _buy(3, 1, 1000e18, bytes4(0));
        // The Safe now holds 1,000 LAUNCH less: shipping the full amount again would promise tokens it lacks.
        mm.attempt(
            3,
            2,
            address(module),
            abi.encodeCall(MandateModule.reship, (ids[2], p)),
            IMandateModule.InsufficientBacking.selector
        );
        p.shippedBase -= 1000e18;
        p.spreadBps = 5;
        mm.attempt(
            3,
            3,
            address(module),
            abi.encodeCall(MandateModule.reship, (ids[2], p)),
            IMandateModule.ParamsOutOfBounds.selector
        );
        mm.attempt(
            3,
            4,
            address(safes[2]),
            abi.encodeCall(
                ISafe.execTransactionFromModuleReturnData,
                (base, 0, abi.encodeCall(IERC20.transfer, (address(mm), 1e18)), ISafe.Operation.Call)
            ),
            bytes4(keccak256("Error(string)"))
        );
        mm.attempt(3, 5, address(module), abi.encodeCall(MandateModule.claimFees, (ids[2])), bytes4(0));
        mm.attempt(3, 6, address(module), abi.encodeCall(MandateModule.pauseStrategy, (ids[2])), bytes4(0));
        _buy(3, 7, 1000e18, IMandateQuoter.StrategyPaused.selector);
        _issuerAttempt(8, abi.encodeCall(MandateModule.unpauseStrategy, (ids[2])));
        _buy(3, 9, 1000e18, bytes4(0));
        _issuerAttempt(10, abi.encodeCall(MandateModule.revokePolicy, (policyIds[2])));
        mm.attempt(3, 11, address(module), abi.encodeCall(MandateModule.claimFees, (ids[2])), bytes4(0));
        p.spreadBps = 30;
        mm.attempt(
            3, 12, address(module), abi.encodeCall(MandateModule.reship, (ids[2], p)), IMandateModule.IsRevoked.selector
        );
        console2.log("Act 3: spread 80 -> 30; backing, bounds and custody enforced; fees claimed before and after revoke.");
    }

    function _issuerAttempt(uint256 step, bytes memory data) private {
        bytes memory sigs = safes[2].signatures(address(module), data, DemoConfig.keys());
        mm.attempt(
            3,
            step,
            address(safes[2]),
            abi.encodeCall(
                ISafeAccount.execTransaction,
                (address(module), 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs)
            ),
            bytes4(0)
        );
    }
}

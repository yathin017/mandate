// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { MandateStrategy } from "../src/libraries/MandateStrategy.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary, PoolKey } from "@uniswap/v4-core/src/types/PoolId.sol";
// Compiled so the SDK generator can export the v4 StateView ABI.
import { IStateView } from "@uniswap/v4-periphery/src/interfaces/IStateView.sol";
import { ISafeAccount } from "./lib/SafeTransactions.sol";

/// @notice Offline golden vectors from the pinned Solidity libraries, for SDK cross-language tests.
contract GenerateSdkFixtures is Script {
    function run() external {
        string memory obj = "sdk-fixtures";
        vm.serializeBytes(obj, "exactInQuote", _traits(true, false, 0, 0));
        vm.serializeBytes(obj, "exactOutQuote", _traits(false, false, 0, 0));
        vm.serializeBytes(obj, "exactInLimited", _traits(true, true, 1001, 1_800_000_000));
        vm.serializeBytes(obj, "exactOutLimited", _traits(false, true, 1001, 1_800_000_000));
        vm.serializeBytes(obj, "zeroThreshold", _traits(true, true, 0, 0));
        vm.serializeBytes(obj, "maxValues", _traits(false, true, type(uint256).max, type(uint40).max));
        vm.serializeBytes(
            obj,
            "orderEncoded",
            abi.encode(MandateStrategy.order(address(0x1000), address(0x2000), bytes32(uint256(1)), 3))
        );
        // Anchor pool id for (base 0x2000, quote 0x1000, hook 0x30..80) with the launcher's fee and spacing.
        PoolKey memory key = PoolKey({
            currency0: Currency.wrap(address(0x1000)),
            currency1: Currency.wrap(address(0x2000)),
            // Literal copies of AnchorLauncher.FEE / TICK_SPACING (contract constants are not readable by type).
            fee: 3000,
            tickSpacing: 60,
            hooks: IHooks(address(0x30Ff096F8582363807a9b5Cb15b84E7d98371080))
        });
        vm.serializeBytes32(obj, "anchorPoolId", PoolId.unwrap(PoolIdLibrary.toId(key)));
        address[] memory owners = new address[](2);
        owners[0] = address(0x1000);
        owners[1] = address(0x2000);
        vm.serializeBytes(
            obj,
            "safeSetup",
            abi.encodeCall(
                ISafeAccount.setup, (owners, 2, address(0), "", address(0), address(0), 0, payable(address(0)))
            )
        );
        string memory json = vm.serializeBytes32(
            obj,
            "orderHash",
            MandateStrategy.strategyHash(
                MandateStrategy.order(address(0x1000), address(0x2000), bytes32(uint256(1)), 3)
            )
        );
        string memory path = string.concat(vm.projectRoot(), "/../packages/sdk/test/fixtures/solidity.json");
        if (vm.envOr("SDK_FIXTURES_CHECK", false)) {
            require(
                keccak256(vm.parseJson(vm.readFile(path))) == keccak256(vm.parseJson(json)), "SDK fixtures are stale"
            );
        } else {
            vm.writeJson(json, path);
        }
    }

    function _traits(
        bool exactIn,
        bool hasThreshold,
        uint256 threshold,
        uint40 deadline
    )
        private
        pure
        returns (bytes memory)
    {
        TakerTraitsLib.Args memory args;
        args.isExactIn = exactIn;
        args.isFirstTransferFromTaker = true;
        args.useTransferFromAndAquaPush = true;
        args.threshold = hasThreshold ? abi.encodePacked(threshold) : bytes("");
        args.deadline = deadline;
        return TakerTraitsLib.build(args);
    }
}

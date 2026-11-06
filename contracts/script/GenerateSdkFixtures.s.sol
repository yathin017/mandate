// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";
import { MandateStrategy } from "../src/libraries/MandateStrategy.sol";

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

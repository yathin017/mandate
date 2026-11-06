// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { MandateModule } from "../../src/module/MandateModule.sol";
import { MandateParams } from "../../src/libraries/MandateTypes.sol";
import { ISafeAccount, SafeTransactions } from "../lib/SafeTransactions.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title RotateRoles
/// @notice Hands the live Base demo to new testing wallets, entirely through the issuer Safe (2-of-2, signed by
///         the current owners' keys from .env):
///         1. revoke the current mandate (its market maker cannot be changed: the MM is part of the deal),
///         2. create a new mandate with NEW_MM as market maker,
///         3. swap Safe owner 2 to NEW_OWNER2 (last, so the current owner-2 key can still sign steps 1 and 2).
/// @dev Dry run:  NEW_OWNER2=0x.. NEW_MM=0x.. forge script script/live/RotateRoles.s.sol --rpc-url $BASE_RPC_URL
///      Broadcast: add --broadcast. deployments/8453.json (owner2, mm, mandate) is updated only when broadcasting.
contract RotateRoles is Script {
    using stdJson for string;

    address internal constant SENTINEL_OWNERS = address(0x1);

    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();
        ISafeAccount safe = ISafeAccount(json.readAddress(".safe"));
        MandateModule module = MandateModule(json.readAddress(".module"));
        bytes32 oldMandate = json.readBytes32(".mandate");
        address base = json.readAddress(".base");
        address quote = json.readAddress(".quote");
        address anchor = json.readAddress(".anchor");
        address oldOwner2 = vm.addr(LiveConfig.owner2Key());
        address newOwner2 = vm.envAddress("NEW_OWNER2");
        address newMm = vm.envAddress("NEW_MM");
        require(newOwner2.code.length == 0 && newMm.code.length == 0, "Rotate: expected EOAs");
        require(newOwner2 != oldOwner2 && newOwner2 != vm.addr(LiveConfig.deployerKey()), "Rotate: owner2 unchanged");

        uint256[] memory keys = LiveConfig.sortedOwnerKeys();
        vm.startBroadcast(LiveConfig.deployerKey());

        // 1. Revoke: the strategy is docked and every fill of the old mandate is refused from now on.
        require(
            SafeTransactions.execute(safe, address(module), abi.encodeCall(MandateModule.revoke, (oldMandate)), keys),
            "Rotate: revoke failed"
        );

        // 2. New mandate with the new MM; ship no more than the Safe actually holds.
        MandateParams memory params = LiveConfig.params();
        params.shippedBase = Math.min(params.shippedBase, IERC20(base).balanceOf(address(safe)));
        params.shippedQuote = Math.min(params.shippedQuote, IERC20(quote).balanceOf(address(safe)));
        bytes memory create =
            abi.encodeCall(MandateModule.createMandate, (newMm, base, quote, LiveConfig.bounds(anchor), params));
        require(SafeTransactions.execute(safe, address(module), create, keys), "Rotate: createMandate failed");
        bytes32[] memory ids = module.mandatesOf(address(safe));
        bytes32 newMandate = ids[ids.length - 1];

        // 3. Owner swap last: Safe's owner list is linked, so pass the owner preceding the one being replaced.
        address prev = _previousOwner(safe, oldOwner2);
        require(
            SafeTransactions.execute(
                safe, address(safe), abi.encodeCall(ISafeAccount.swapOwner, (prev, oldOwner2, newOwner2)), keys
            ),
            "Rotate: swapOwner failed"
        );
        vm.stopBroadcast();

        address[] memory owners = safe.getOwners();
        require(owners.length == 2 && safe.getThreshold() == 2, "Rotate: Safe shape changed");
        require(owners[0] == newOwner2 || owners[1] == newOwner2, "Rotate: new owner missing");
        console.log("new mandate:");
        console.logBytes32(newMandate);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory path = LiveConfig.path();
            vm.writeJson(string.concat('"', vm.toString(newOwner2), '"'), path, ".owner2");
            vm.writeJson(string.concat('"', vm.toString(newMm), '"'), path, ".mm");
            vm.writeJson(string.concat('"', vm.toString(newMandate), '"'), path, ".mandate");
        }
    }

    function _previousOwner(ISafeAccount safe, address owner) private view returns (address) {
        address[] memory owners = safe.getOwners();
        for (uint256 i; i < owners.length; ++i) {
            if (owners[i] == owner) return i == 0 ? SENTINEL_OWNERS : owners[i - 1];
        }
        revert("Rotate: owner not found");
    }
}

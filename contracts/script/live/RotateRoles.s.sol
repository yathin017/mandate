// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { VmSafe } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { MandateModule } from "../../src/module/MandateModule.sol";
import { Policy, Strategy, StrategyParams } from "../../src/libraries/MandateTypes.sol";
import { ISafeAccount, SafeTransactions } from "../lib/SafeTransactions.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title RotateRoles
/// @notice Hands the live Base demo to new testing wallets, entirely through the issuer Safe (2-of-2, signed by
///         the current owners' keys from .env):
///         1. revoke STRATEGY (its market maker cannot be changed: the MM is part of the deal),
///         2. add a new strategy under the same policy with NEW_MM as market maker and the revoked strategy's own
///            kind, bounds and params (shipped amounts capped to what the Safe can back), so no new terms are chosen,
///         3. swap Safe owner 2 to NEW_OWNER2 (last, so the current owner-2 key can still sign steps 1 and 2).
/// @dev Needs BASE_OWNER2_PRIVATE_KEY (the current Owner 2) in .env, since both owners sign.
///      Dry run:  STRATEGY=0x.. NEW_OWNER2=0x.. NEW_MM=0x.. forge script script/live/RotateRoles.s.sol --rpc-url $BASE_RPC_URL
///      Broadcast: add --broadcast. deployments/8453.json (owner2, mm) is updated only when broadcasting.
contract RotateRoles is Script {
    using stdJson for string;

    address internal constant SENTINEL_OWNERS = address(0x1);

    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();
        ISafeAccount safe = ISafeAccount(json.readAddress(".safe"));
        MandateModule module = MandateModule(json.readAddress(".module"));
        bytes32 oldStrategy = vm.envBytes32("STRATEGY");
        Strategy memory old = module.getStrategy(oldStrategy);
        bytes32 policyId = old.policyId;
        Policy memory policy = module.getPolicy(policyId);
        require(policy.safe == address(safe), "Rotate: strategy belongs to another Safe");
        address base = policy.base;
        address quote = policy.quote;
        address oldOwner2 = vm.addr(LiveConfig.owner2Key());
        address newOwner2 = vm.envAddress("NEW_OWNER2");
        address newMm = vm.envAddress("NEW_MM");
        require(newOwner2.code.length == 0 && newMm.code.length == 0, "Rotate: expected EOAs");
        require(newOwner2 != oldOwner2 && newOwner2 != vm.addr(LiveConfig.deployerKey()), "Rotate: owner2 unchanged");

        uint256[] memory keys = LiveConfig.sortedOwnerKeys();
        vm.startBroadcast(LiveConfig.deployerKey());

        // 1. Revoke: the strategy is docked and every fill of it is refused from now on. The policy and its counters
        //    stay, so the new market maker inherits the period's usage instead of a fresh budget.
        require(
            SafeTransactions.execute(
                safe, address(module), abi.encodeCall(MandateModule.revokeStrategy, (oldStrategy)), keys
            ),
            "Rotate: revoke failed"
        );

        // 2. New strategy with the new MM on the revoked one's terms; ship no more than the Safe can back (the module
        //    sums every live strategy, and the revoked one no longer counts).
        StrategyParams memory params = old.params;
        params.shippedBase = Math.min(params.shippedBase, IERC20(base).balanceOf(address(safe)));
        params.shippedQuote = Math.min(params.shippedQuote, IERC20(quote).balanceOf(address(safe)));
        bytes memory add = abi.encodeCall(MandateModule.addStrategy, (policyId, newMm, old.kind, old.bounds, params));
        require(SafeTransactions.execute(safe, address(module), add, keys), "Rotate: addStrategy failed");
        bytes32[] memory ids = module.strategiesOf(policyId);
        bytes32 newStrategy = ids[ids.length - 1];

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
        console.log("new strategy:");
        console.logBytes32(newStrategy);

        if (vm.isContext(VmSafe.ForgeContext.ScriptBroadcast)) {
            string memory path = LiveConfig.path();
            vm.writeJson(string.concat('"', vm.toString(newOwner2), '"'), path, ".owner2");
            vm.writeJson(string.concat('"', vm.toString(newMm), '"'), path, ".mm");
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

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { ScenarioActor } from "../../script/demo/ScenarioActor.sol";
import { DemoConfig } from "../../script/lib/DemoConfig.sol";

contract ScenarioTarget {
    uint256 public count;
    error Denied();

    function execute(bool fail) external returns (uint256) {
        ++count;
        require(!fail, Denied());
        return count;
    }
}

/// @notice A replay must fail closed when an expected success/revert does not match the actual call.
contract ScenarioActorTest is Test {
    ScenarioActor internal actor = new ScenarioActor();
    ScenarioTarget internal target = new ScenarioTarget();

    event Attempted(uint256 indexed act, uint256 indexed step, address target, bool success, bytes result);

    function test_successRecordsActualReturnData() public {
        vm.expectEmit(true, true, false, true, address(actor));
        emit Attempted(1, 1, address(target), true, abi.encode(uint256(1)));
        actor.attempt(1, 1, address(target), abi.encodeCall(ScenarioTarget.execute, (false)), bytes4(0));
        assertEq(target.count(), 1);
    }

    function test_expectedRevertRecordsDataAndRollsBackInnerState() public {
        vm.expectEmit(true, true, false, true, address(actor));
        emit Attempted(1, 2, address(target), false, abi.encodeWithSelector(ScenarioTarget.Denied.selector));
        actor.attempt(
            1, 2, address(target), abi.encodeCall(ScenarioTarget.execute, (true)), ScenarioTarget.Denied.selector
        );
        assertEq(target.count(), 0);
    }

    function test_unexpectedSuccessRevertsAndRollsBackState() public {
        vm.expectRevert(bytes("ScenarioActor: unexpected revert"));
        actor.attempt(
            1, 1, address(target), abi.encodeCall(ScenarioTarget.execute, (false)), ScenarioTarget.Denied.selector
        );
        assertEq(target.count(), 0);
    }

    function test_unexpectedFailureCannotBeRecordedAsSuccess() public {
        vm.expectRevert(bytes("ScenarioActor: unexpected failure"));
        actor.attempt(1, 1, address(target), abi.encodeCall(ScenarioTarget.execute, (true)), bytes4(0));
    }

    function test_wrongRevertCannotBeRecordedAsExpectedBlock() public {
        vm.expectRevert(bytes("ScenarioActor: unexpected revert"));
        actor.attempt(
            1, 1, address(target), abi.encodeCall(ScenarioTarget.execute, (true)), bytes4(keccak256("Other()"))
        );
    }

    function test_strangerCannotControlActor() public {
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("ScenarioActor: owner only"));
        actor.attempt(1, 1, address(target), abi.encodeCall(ScenarioTarget.execute, (false)), bytes4(0));
    }

    function test_demoGuardRejectsMainnetChainId() public {
        DemoConfig.guard();
        vm.chainId(1);
        vm.expectRevert(bytes("Demo: local chain 31337 only"));
        this.probeGuard();
    }

    function probeGuard() external view {
        DemoConfig.guard();
    }
}

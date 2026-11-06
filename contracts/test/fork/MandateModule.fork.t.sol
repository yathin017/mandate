// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";

import { IMandateModule } from "../../src/interfaces/IMandateModule.sol";
import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { ISafe } from "../../src/interfaces/ISafe.sol";
import {
    PolicyConfig, RiskReason, Status, Strategy, StrategyBounds, StrategyKind, StrategyParams
} from "../../src/libraries/MandateTypes.sol";
import { MandateModule } from "../../src/module/MandateModule.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";
import { ChainConfig, ChainConfigLib } from "../../script/lib/ChainConfig.sol";

import { AquaTaker } from "../../src/mocks/AquaTaker.sol";
import { MandateFixture } from "../utils/MandateFixture.sol";
import { ISafeAccount, SafeTransactions } from "../../script/lib/SafeTransactions.sol";
import { V4AnchorSetup } from "../utils/V4AnchorSetup.sol";

/// @notice Complete policy and strategy lifecycle on canonical Safe 1.4.1, Aqua, SwapVM and v4 bytecode, with the real
///         market oracle over a hooked v4 pool.
/// @dev Issuer actions need two real test-owner signatures. Tokens and oracle history are SYNTHETIC.
///      Skipped only when MAINNET_RPC_URL is unset, just like the other fork suites.
contract MandateModuleForkTest is V4AnchorSetup {
    using SafeTransactions for ISafeAccount;

    MandateModule internal module;
    ISafeAccount internal issuer;
    uint256[] internal ownerKeys;
    bytes32 internal policyId;
    bytes32 internal id;

    function _venue() internal view override returns (IAqua, ISwapVM) {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        return (IAqua(cfg.aqua), ISwapVM(cfg.swapVmRouter));
    }

    function setUp() public {
        ChainConfig memory cfg = ChainConfigLib.load(1);
        if (bytes(vm.envOr(cfg.rpcEnv, string(""))).length == 0) {
            vm.skip(true);
            return;
        }
        ChainConfigLib.selectFork(cfg);
        (aqua, router) = _venue();
        module = new MandateModule(address(router), aqua);
        quoter = module.QUOTER();
        launch = new MockERC20("Launch Token", "LAUNCH", 18);
        usdc = new MockERC20("USD Coin", "USDC", 6);
        taker = new AquaTaker(aqua, router);

        _setUpV4(IPoolManager(cfg.v4PoolManager), MandateFixture.SPOT_X36);
        moveV4PriceTo(MandateFixture.SPOT_X36 + 1e20);
        vm.warp(block.timestamp + 1 hours);
        vm.roll(block.number + 300);

        (address ownerA, uint256 keyA) = makeAddrAndKey("safeOwnerA");
        (address ownerB, uint256 keyB) = makeAddrAndKey("safeOwnerB");
        ownerKeys.push(ownerA < ownerB ? keyA : keyB);
        ownerKeys.push(ownerA < ownerB ? keyB : keyA);
        issuer = _createSafe(cfg, 1);
        safe = address(issuer);
        launch.mint(safe, SHIP_LAUNCH);
        usdc.mint(safe, SHIP_USDC);

        _asIssuer(safe, abi.encodeCall(ISafeAccount.enableModule, (address(module))));
        _asIssuer(
            address(module), abi.encodeCall(MandateModule.createPolicy, (address(launch), address(usdc), _config()))
        );
        policyId = module.activePolicyOf(safe, address(launch));
        _asIssuer(
            address(module),
            abi.encodeCall(
                MandateModule.addStrategy,
                (policyId, mm, StrategyKind.MarketMaking, _bounds(), _params(80, SHIP_LAUNCH))
            )
        );
        id = module.strategiesOf(policyId)[0];
    }

    function test_fork_createUsesRealMultisigAndShipsFromSafe() public view {
        assertEq(issuer.VERSION(), "1.4.1");
        assertEq(issuer.getThreshold(), 2);
        assertEq(issuer.getOwners().length, 2);
        assertTrue(issuer.isModuleEnabled(address(module)));
        assertEq(issuer.nonce(), 3, "enable, create policy and add strategy are signed Safe transactions");
        Strategy memory m = module.getStrategy(id);
        assertEq(module.getPolicy(policyId).safe, safe);
        assertEq(address(quoter.REGISTRY()), address(module));
        assertEq(m.activeStrategyHash, router.hash(module.activeOrder(id)));
        (uint256 b, uint256 q) =
            aqua.safeBalances(safe, address(router), m.activeStrategyHash, address(launch), address(usdc));
        assertEq(b, SHIP_LAUNCH);
        assertEq(q, SHIP_USDC);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH, "shipping does not move tokens");
        assertEq(usdc.balanceOf(safe), SHIP_USDC);
    }

    function test_fork_fillMovesTokensAndMmClaimsBothFeeTokens() public {
        ISwapVM.Order memory o = module.activeOrder(id);
        uint256 paid = _buyLaunch(o, 10_000e18);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH - 10_000e18);
        assertEq(usdc.balanceOf(safe), SHIP_USDC + paid);

        // A two-sided MM earns quote fees on sells and base fees on treasury buybacks.
        launch.mint(address(taker), 1000e18);
        taker.swap(o, address(launch), address(usdc), 1000e18, true);
        (uint256 baseFees, uint256 quoteFees) = quoter.feesAccrued(id);
        (uint256 baseDue, uint256 quoteDue) = module.claimable(id);
        assertGt(baseDue, 0);
        assertGt(quoteDue, 0);
        assertEq(baseDue, baseFees / 2);
        assertEq(quoteDue, quoteFees / 2);
        uint256 safeBaseBefore = launch.balanceOf(safe);
        uint256 safeQuoteBefore = usdc.balanceOf(safe);

        vm.prank(mm);
        module.claimFees(id);
        assertEq(launch.balanceOf(mm), baseDue);
        assertEq(usdc.balanceOf(mm), quoteDue);
        assertEq(launch.balanceOf(safe), safeBaseBefore - baseDue);
        assertEq(usdc.balanceOf(safe), safeQuoteBefore - quoteDue);
        (baseDue, quoteDue) = module.claimable(id);
        assertEq(baseDue, 0);
        assertEq(quoteDue, 0);
        vm.prank(mm);
        vm.expectRevert(IMandateModule.NothingToClaim.selector);
        module.claimFees(id);
    }

    function test_fork_reshipPreservesCountersAndInvalidatesOldOrder() public {
        ISwapVM.Order memory oldOrder = module.activeOrder(id);
        _buyLaunch(oldOrder, 10_000e18);
        vm.prank(mm);
        module.reship(id, _params(30, SHIP_LAUNCH - 10_000e18));
        assertEq(module.strategyNonce(id), 2);
        IMandateQuoter.PolicyCounters memory c = quoter.policyCounters(policyId);
        assertEq(c.grossSold, 10_000e18);
        assertEq(c.totalNetSold, 10_000e18);
        assertTrue(router.hash(oldOrder) != module.getStrategy(id).activeStrategyHash);
        vm.expectRevert(); // Aqua rejects the docked order before entering the quoter.
        taker.quote(oldOrder, address(usdc), address(launch), 1000e18, false);
        _buyLaunch(module.activeOrder(id), 1000e18);
    }

    function test_fork_singleOwnerSignatureCannotRevoke() public {
        bytes memory data = abi.encodeCall(MandateModule.revokePolicy, (policyId));
        uint256[] memory oneKey = new uint256[](1);
        oneKey[0] = ownerKeys[0];
        bytes memory sigs = issuer.signatures(address(module), data, oneKey);
        uint256 nonceBefore = issuer.nonce();
        vm.expectRevert(bytes("GS020")); // Not enough signatures for the configured threshold.
        issuer.execTransaction(
            address(module), 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        assertEq(issuer.nonce(), nonceBefore);
        assertEq(uint8(module.getPolicy(policyId).status), uint8(Status.Active));
    }

    function test_fork_ownerSignaturesCannotBeReplayed() public {
        bytes memory data = abi.encodeCall(MandateModule.pauseStrategy, (id));
        bytes memory sigs = issuer.signatures(address(module), data, ownerKeys);
        assertTrue(
            issuer.execTransaction(
                address(module), 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs
            )
        );
        uint256 nonceAfter = issuer.nonce();
        // The consumed nonce changes the digest; the old signatures no longer identify the owners.
        vm.expectRevert(bytes("GS026"));
        issuer.execTransaction(
            address(module), 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        assertEq(issuer.nonce(), nonceAfter);
    }

    function test_fork_mmCannotEnableItselfOrTransferSafeTokens() public {
        vm.prank(mm);
        vm.expectRevert(bytes("GS031")); // Module membership changes require a Safe self-call.
        issuer.enableModule(mm);
        vm.prank(mm);
        vm.expectRevert(bytes("GS104")); // The MM is not an enabled Safe module.
        issuer.execTransactionFromModuleReturnData(
            address(launch), 0, abi.encodeCall(IERC20.transfer, (mm, 1e18)), ISafe.Operation.Call
        );
        assertEq(launch.balanceOf(mm), 0);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH);
    }

    function test_fork_pauseOnlyIssuerCanResume() public {
        ISwapVM.Order memory o = module.activeOrder(id);
        vm.prank(mm);
        module.pauseStrategy(id);
        vm.expectRevert(IMandateQuoter.StrategyPaused.selector);
        taker.quote(o, address(usdc), address(launch), 1000e18, false);
        vm.prank(mm);
        vm.expectRevert(abi.encodeWithSelector(IMandateModule.NotIssuer.selector, mm));
        module.unpauseStrategy(id);
        _asIssuer(address(module), abi.encodeCall(MandateModule.unpauseStrategy, (id)));
        _buyLaunch(o, 1000e18);
    }

    function test_fork_revokeDocksButEarnedFeesRemainClaimable() public {
        ISwapVM.Order memory o = module.activeOrder(id);
        _buyLaunch(o, 1000e18);
        (, uint256 due) = module.claimable(id);
        assertGt(due, 0);
        _asIssuer(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        assertEq(uint8(module.getStrategy(id).status), uint8(Status.Revoked));
        vm.expectRevert();
        taker.quote(o, address(usdc), address(launch), 1000e18, false);
        vm.prank(mm);
        vm.expectRevert(IMandateModule.IsRevoked.selector);
        module.reship(id, _params(30, SHIP_LAUNCH));
        vm.prank(mm);
        module.claimFees(id);
        assertEq(usdc.balanceOf(mm), due);
    }

    function test_fork_revokeStillWorksAfterModuleDisabled() public {
        ISwapVM.Order memory o = module.activeOrder(id);
        bytes32 hash = module.getStrategy(id).activeStrategyHash;
        // There is exactly one module, so its predecessor in Safe's linked list is the sentinel.
        _asIssuer(safe, abi.encodeCall(ISafeAccount.disableModule, (address(1), address(module))));
        assertFalse(issuer.isModuleEnabled(address(module)));
        _asIssuer(address(module), abi.encodeCall(MandateModule.revokePolicy, (policyId)));
        assertEq(uint8(module.getStrategy(id).status), uint8(Status.Revoked));
        (uint256 b, uint256 q) = aqua.safeBalances(safe, address(router), hash, address(launch), address(usdc));
        assertEq(b, SHIP_LAUNCH, "dock failed but revoke succeeded");
        assertEq(q, SHIP_USDC);
        vm.expectRevert(IMandateQuoter.PolicyRevoked.selector);
        taker.quote(o, address(usdc), address(launch), 1000e18, false);
        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(IMandateQuoter.PolicyRevoked.selector);
        taker.swap(o, address(usdc), address(launch), 1000e6, true);
    }

    function test_fork_twoSafesShareModuleButCannotControlEachOther() public {
        ISafeAccount other = _createSafe(ChainConfigLib.load(1), 2);
        launch.mint(address(other), SHIP_LAUNCH);
        usdc.mint(address(other), SHIP_USDC);
        assertTrue(
            other.execute(address(other), abi.encodeCall(ISafeAccount.enableModule, (address(module))), ownerKeys)
        );
        assertTrue(
            other.execute(
                address(module),
                abi.encodeCall(MandateModule.createPolicy, (address(launch), address(usdc), _config())),
                ownerKeys
            )
        );
        bytes32 otherPolicy = module.activePolicyOf(address(other), address(launch));
        assertTrue(otherPolicy != policyId);
        assertTrue(
            other.execute(
                address(module),
                abi.encodeCall(
                    MandateModule.addStrategy,
                    (otherPolicy, mm, StrategyKind.MarketMaking, _bounds(), _params(30, SHIP_LAUNCH))
                ),
                ownerKeys
            )
        );
        bytes32 otherId = module.strategiesOf(otherPolicy)[0];
        assertTrue(otherId != id);
        _buyLaunch(module.activeOrder(otherId), 1000e18);
        assertEq(launch.balanceOf(address(other)), SHIP_LAUNCH - 1000e18);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH);
        assertEq(quoter.policyCounters(otherPolicy).totalNetSold, 1000e18);
        assertEq(quoter.policyCounters(policyId).totalNetSold, 0, "counters are isolated between Safes");
        // Safe wraps a failed inner call as GS013 when safeTxGas and gasPrice are zero.
        bytes memory data = abi.encodeCall(MandateModule.revokePolicy, (policyId));
        bytes memory sigs = other.signatures(address(module), data, ownerKeys);
        vm.expectRevert(bytes("GS013"));
        other.execTransaction(
            address(module), 0, data, ISafe.Operation.Call, 0, 0, 0, address(0), payable(address(0)), sigs
        );
        assertEq(uint8(module.getPolicy(policyId).status), uint8(Status.Active));
    }

    function test_fork_livePriceBreakerBlocksActualSafeFillThenRecovers() public {
        ISwapVM.Order memory o = module.activeOrder(id);
        moveV4PriceTo(6e23);
        usdc.mint(address(taker), 1000e6);
        vm.expectRevert(abi.encodeWithSelector(IMandateQuoter.RiskPaused.selector, RiskReason.MoveBeyondPause));
        taker.swap(o, address(usdc), address(launch), 1000e6, true);
        assertEq(launch.balanceOf(safe), SHIP_LAUNCH);
        assertEq(quoter.policyCounters(policyId).totalNetSold, 0);
        moveV4PriceTo(MandateFixture.SPOT_X36);
        _buyLaunch(o, 1000e18);
    }

    function _createSafe(ChainConfig memory cfg, uint256 saltNonce) internal returns (ISafeAccount) {
        address[] memory owners = new address[](2);
        owners[0] = vm.addr(ownerKeys[0]);
        owners[1] = vm.addr(ownerKeys[1]);
        return SafeTransactions.create(cfg.safeSingletonL2, cfg.safeProxyFactory, owners, 2, saltNonce);
    }

    function _asIssuer(address to, bytes memory data) internal {
        assertTrue(issuer.execute(to, data, ownerKeys), "signed issuer transaction failed");
    }

    function _config() internal view returns (PolicyConfig memory) {
        return MandateFixture.policyConfig(address(marketOracle), uint64(block.timestamp - 20 days));
    }

    function _bounds() internal pure returns (StrategyBounds memory) {
        return MandateFixture.marketMakingBounds(SHIP_LAUNCH, SHIP_USDC);
    }

    function _params(uint16 spread, uint256 shippedBase) internal pure returns (StrategyParams memory) {
        return StrategyParams({ spreadBps: spread, shippedBase: shippedBase, shippedQuote: SHIP_USDC });
    }
}

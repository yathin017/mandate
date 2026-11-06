// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Script, console } from "forge-std/Script.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { ModifyLiquidityParams } from "@uniswap/v4-core/src/types/PoolOperation.sol";
import { PoolModifyLiquidityTest } from "@uniswap/v4-core/src/test/PoolModifyLiquidityTest.sol";

import { AnchorLauncher } from "../../src/anchor/AnchorLauncher.sol";
import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { ISafe } from "../../src/interfaces/ISafe.sol";
import { MockERC20 } from "../../src/mocks/MockERC20.sol";
import { ChainConfig, ChainConfigLib } from "../lib/ChainConfig.sol";
import { ISafeAccount, SafeTransactions } from "../lib/SafeTransactions.sol";
import { LiveConfig } from "./LiveConfig.sol";

/// @title OnboardPair
/// @notice Owner 1's half of a self-serve onboarding on Base, so the second owner finishes it in the web wizard:
///         a new demo pair minted into a new 2-of-2 Safe (Owner 1 + the manifest's owner 2), the pair's anchor
///         created through the AnchorLauncher, a full-range liquidity position so the anchor price is not free to
///         move, and Owner 1's onchain approval of `enableModule` (Safe nonce 0).
/// @dev The policy and strategy are approved separately from the wizard's shared link (apps/web/scripts/approve-terms.ts),
///      so both owners sign byte-identical calldata built by the web app's terms module.
///      Dry run:  forge script script/live/OnboardPair.s.sol --rpc-url $BASE_RPC_URL
///      Broadcast: add --broadcast. Only Owner 1's key is used; nothing is signed for owner 2.
contract OnboardPair is Script {
    using stdJson for string;

    /// @dev 0.40 quote per base in `quoteRaw * 1e36 / baseRaw` units (18-decimal base, 6-decimal quote).
    uint256 internal constant PRICE = 4e23;
    uint256 internal constant SAFE_BASE = 1_000_000e18;
    uint256 internal constant SAFE_QUOTE = 400_000e6;
    /// @dev Same depth as the live demo pool (LiveConfig.POOL_LIQUIDITY).
    int256 internal constant LIQUIDITY = LiveConfig.POOL_LIQUIDITY;

    function run() external {
        LiveConfig.guard();
        string memory json = LiveConfig.manifest();
        ChainConfig memory cfg = ChainConfigLib.load(LiveConfig.CHAIN_ID);
        AnchorLauncher launcher = AnchorLauncher(json.readAddress(".anchorLauncher"));
        PoolModifyLiquidityTest liquidityRouter = PoolModifyLiquidityTest(json.readAddress(".liquidityRouter"));
        address module = json.readAddress(".module");
        address owner1 = vm.addr(LiveConfig.deployerKey());
        address owner2 = json.readAddress(".owner2");

        vm.startBroadcast(LiveConfig.deployerKey());
        MockERC20 base = new MockERC20("Demo Nova", "dNOVA", 18);
        MockERC20 quote = new MockERC20("Demo Dollar", "dUSD", 6);

        address[] memory owners = new address[](2);
        (owners[0], owners[1]) = (owner1, owner2);
        // Timestamp salt: a re-run never collides with an earlier Safe.
        ISafeAccount safe =
            SafeTransactions.create(cfg.safeSingletonL2, cfg.safeProxyFactory, owners, 2, block.timestamp);
        base.mint(address(safe), SAFE_BASE);
        quote.mint(address(safe), SAFE_QUOTE);

        (UniswapV4MarketOracle anchor,, bool poolCreated) = launcher.launch(address(base), address(quote), PRICE);
        require(poolCreated, "Onboard: pool already existed");
        _seed(launcher, liquidityRouter, base, quote);

        // Owner 1 approves enableModule at nonce 0; owner 2 executes it from the wizard.
        bytes32 enableHash = safe.getTransactionHash(
            address(safe),
            0,
            abi.encodeCall(ISafeAccount.enableModule, (module)),
            ISafe.Operation.Call,
            0,
            0,
            0,
            address(0),
            address(0),
            0
        );
        safe.approveHash(enableHash);
        vm.stopBroadcast();

        console.log("Safe:   ", address(safe));
        console.log("Base:   ", address(base));
        console.log("Quote:  ", address(quote));
        console.log("Anchor: ", address(anchor));
    }

    /// @dev Owner 1 provides the liquidity from freshly minted demo tokens; the Safe's balances are untouched.
    function _seed(
        AnchorLauncher launcher,
        PoolModifyLiquidityTest liquidityRouter,
        MockERC20 base,
        MockERC20 quote
    )
        private
    {
        address owner1 = vm.addr(LiveConfig.deployerKey());
        // Full range at 0.40 needs ~9.5M base and ~3.8M quote for LIQUIDITY; mint with headroom.
        base.mint(owner1, 20 * SAFE_BASE);
        quote.mint(owner1, 20 * SAFE_QUOTE);
        IERC20(address(base)).approve(address(liquidityRouter), type(uint256).max);
        IERC20(address(quote)).approve(address(liquidityRouter), type(uint256).max);
        PoolKey memory key = launcher.poolKeyFor(address(base), address(quote));
        liquidityRouter.modifyLiquidity(
            key,
            ModifyLiquidityParams({
                tickLower: TickMath.minUsableTick(key.tickSpacing),
                tickUpper: TickMath.maxUsableTick(key.tickSpacing),
                liquidityDelta: LIQUIDITY,
                salt: 0
            }),
            ""
        );
    }
}

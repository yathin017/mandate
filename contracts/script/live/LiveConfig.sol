// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";

import {
    ModeLimits,
    OracleRules,
    PeriodLimits,
    PolicyConfig,
    PriceRules,
    ReleaseLimits,
    StrategyBounds,
    StrategyKind,
    StrategyParams
} from "../../src/libraries/MandateTypes.sol";

/// @notice Settings for the live Base mainnet demo (chain 8453). Tokens are worthless owner-mintable mocks with
///         clearly-test names; keys are throwaway keys read from the gitignored .env, never from source.
library LiveConfig {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant CHAIN_ID = 8453;
    /// @dev 0.40 mUSD per mLAUNCH in `quoteRaw * 1e36 / baseRaw` units.
    uint256 internal constant PRICE = 4e23;
    uint256 internal constant ALLOTMENT = 1_000_000e18;
    uint256 internal constant BUYBACK = 400_000e6;
    uint256 internal constant DAILY_NET_CAP = 50_000e18;
    /// @dev Full-range liquidity of the demo anchor pool: ~9.5M mLAUNCH / ~3.8M mUSD at 0.40, so a 5% move takes
    ///      ~230k mLAUNCH of trusted depth.
    int256 internal constant POOL_LIQUIDITY = 6e18;
    /// @dev Liquidity added within this many seconds is not trusted depth yet (hook constructor argument).
    uint32 internal constant SETTLE_SECONDS = 10 minutes;
    /// @dev Gas top-up for the second Safe owner and the market maker (enough for dozens of Base transactions).
    uint256 internal constant GAS_TOPUP = 0.0002 ether;

    function guard() internal view {
        require(block.chainid == CHAIN_ID, "Live: Base mainnet (8453) only");
    }

    function deployerKey() internal view returns (uint256) {
        return VM.envUint("BASE_DEPLOYER_PRIVATE_KEY");
    }

    function owner2Key() internal view returns (uint256) {
        return VM.envUint("BASE_OWNER2_PRIVATE_KEY");
    }

    function mmKey() internal view returns (uint256) {
        return VM.envUint("BASE_MM_PRIVATE_KEY");
    }

    /// @dev Both Safe owner keys, sorted by owner address as Safe signature checks require.
    function sortedOwnerKeys() internal view returns (uint256[] memory keys) {
        keys = new uint256[](2);
        (uint256 a, uint256 b) = (deployerKey(), owner2Key());
        (keys[0], keys[1]) = VM.addr(a) < VM.addr(b) ? (a, b) : (b, a);
    }

    function path() internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/../deployments/8453.json");
    }

    function manifest() internal view returns (string memory json) {
        json = VM.readFile(path());
        require(json.readUint(".chainId") == CHAIN_ID, "Live: manifest chain mismatch");
    }

    /// @dev SYNTHETIC demo policy scaled to a 1M allotment. Release began 20 days ago so some inventory is sellable at
    ///      once. On the platform every value is the issuer's choice; these only seed the live demo.
    function policy(address oracle) internal view returns (PolicyConfig memory) {
        return PolicyConfig({
            release: ReleaseLimits({
                allotment: ALLOTMENT, releaseStart: uint64(block.timestamp - 20 days), releaseDuration: 180 days
            }),
            period: PeriodLimits({
                periodLength: 1 days, grossSellCap: 2 * DAILY_NET_CAP, netSellCap: DAILY_NET_CAP, quoteSpendCap: 20_000e6
            }),
            price: PriceRules({ floorPriceX36: 3e23, maxQuoteDeviationBps: 300, maxImpactBps: 300 }),
            oracle: OracleRules({
                oracle: oracle,
                twapWindow: 30 minutes,
                shortWindow: 5 minutes,
                depthBandBps: 500,
                minPoolAge: 1 hours,
                minTrustedDepth: 50_000e18,
                defensiveMoveBps: 200,
                pauseMoveBps: 1000,
                defensiveVolatilityBps: 300,
                pauseVolatilityBps: 1500,
                defensiveDepth: 100_000e18
            }),
            normal: ModeLimits({ maxFillBase: 50_000e18, maxFillDepthBps: 2000, minSpreadBps: 0, buybacksAllowed: true }),
            defensive: ModeLimits({ maxFillBase: 10_000e18, maxFillDepthBps: 1000, minSpreadBps: 150, buybacksAllowed: false })
        });
    }

    function strategyBounds() internal pure returns (StrategyBounds memory) {
        return StrategyBounds({
            spreadBpsMin: 10,
            spreadBpsMax: 200,
            maxShippedBase: ALLOTMENT,
            maxShippedQuote: BUYBACK,
            mmFeeShareBps: 5000,
            maxBuyPriceX36: 0
        });
    }

    function params() internal pure returns (StrategyParams memory) {
        return StrategyParams({ spreadBps: 80, shippedBase: ALLOTMENT, shippedQuote: BUYBACK });
    }

    /// @dev The demo's strategies are two-sided market making.
    function kind() internal pure returns (StrategyKind) {
        return StrategyKind.MarketMaking;
    }
}

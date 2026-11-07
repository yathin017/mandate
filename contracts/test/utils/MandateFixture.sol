// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {
    ModeLimits,
    OracleRules,
    PeriodLimits,
    PolicyConfig,
    PriceRules,
    ReleaseLimits,
    StrategyBounds,
    StrategyParams
} from "../../src/libraries/MandateTypes.sol";

/// @notice Test inputs for policies and strategies. These are arbitrary numbers chosen to exercise the rules, not
///         recommendations: on the platform every value is the issuer's choice.
/// @dev Prices assume an 18-decimal base and a 6-decimal quote.
library MandateFixture {
    uint256 internal constant ALLOTMENT = 10_000_000e18;
    uint256 internal constant GROSS_CAP = 300_000e18;
    uint256 internal constant NET_CAP = 200_000e18;
    uint256 internal constant QUOTE_SPEND_CAP = 100_000e6;
    uint256 internal constant FLOOR_X36 = 3e23; // 0.30 quote per base
    uint256 internal constant SPOT_X36 = 4e23; // 0.40 quote per base
    uint256 internal constant NORMAL_MAX_FILL = 100_000e18;
    uint256 internal constant DEFENSIVE_MAX_FILL = 20_000e18;
    uint16 internal constant DEFENSIVE_MIN_SPREAD = 150;
    uint16 internal constant SPREAD_BPS = 30;

    function policyConfig(address oracle, uint64 releaseStart) internal pure returns (PolicyConfig memory) {
        return PolicyConfig({
            release: ReleaseLimits({ allotment: ALLOTMENT, releaseStart: releaseStart, releaseDuration: 180 days }),
            period: PeriodLimits({
                periodLength: 1 days,
                grossSellCap: GROSS_CAP,
                netSellCap: NET_CAP,
                quoteSpendCap: QUOTE_SPEND_CAP
            }),
            price: PriceRules({ floorPriceX36: FLOOR_X36, maxQuoteDeviationBps: 300, maxImpactBps: 300 }),
            oracle: OracleRules({
                oracle: oracle,
                twapWindow: 30 minutes,
                shortWindow: 5 minutes,
                depthBandBps: 200,
                minPoolAge: 1 hours,
                minTrustedDepth: 50_000e18,
                defensiveMoveBps: 200,
                pauseMoveBps: 1000,
                defensiveVolatilityBps: 300,
                pauseVolatilityBps: 1500,
                defensiveDepth: 200_000e18
            }),
            normal: ModeLimits({ maxFillBase: NORMAL_MAX_FILL, maxFillDepthBps: 5000, minSpreadBps: 0, buybacksAllowed: true }),
            defensive: ModeLimits({
                maxFillBase: DEFENSIVE_MAX_FILL,
                maxFillDepthBps: 2000,
                minSpreadBps: DEFENSIVE_MIN_SPREAD,
                buybacksAllowed: false
            })
        });
    }

    function marketMakingBounds(uint256 maxBase, uint256 maxQuote) internal pure returns (StrategyBounds memory) {
        return StrategyBounds({
            spreadBpsMin: 10,
            spreadBpsMax: 200,
            maxShippedBase: maxBase,
            maxShippedQuote: maxQuote,
            mmFeeShareBps: 5000,
            maxBuyPriceX36: 0
        });
    }

    function params(uint256 base, uint256 quote) internal pure returns (StrategyParams memory) {
        return StrategyParams({ spreadBps: SPREAD_BPS, shippedBase: base, shippedQuote: quote });
    }
}

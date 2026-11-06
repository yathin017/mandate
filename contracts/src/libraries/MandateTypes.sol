// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// DRAFT: field set and layout are not final; they may change with client requirements.
// Keep MandateModule, MandateQuoter, the SDK (packages/sdk) and the indexer schema in sync when editing.
//
// Every value in these structs is chosen by the issuer (or proposed by the market maker and accepted by the issuer).
// Contracts only check that values are consistent; they never assume a default.
// Prices are `quoteRaw * 1e36 / baseRaw` (MandateMath.PRICE_SCALE); amounts are raw token units; BPS = 10,000.

/// @notice Lifecycle shared by policies and strategies. `None` means the id was never created.
enum Status {
    None,
    Active,
    Paused,
    Revoked
}

/// @notice What a strategy may do. Defensive behaviour is a risk *mode*, not a strategy kind.
enum StrategyKind {
    /// @dev Two-sided: the treasury sells base and buys it back.
    MarketMaking,
    /// @dev The treasury only buys base, at or below the strategy's max buy price, spending the policy's quote budget.
    Buyback
}

/// @notice How much risk the policy allows right now, derived on every fill from the oracle's readings.
enum RiskMode {
    Normal,
    Defensive,
    Paused
}

/// @notice Why the policy is in its current mode (first matching rule, in the order listed).
enum RiskReason {
    None,
    Unpriced,
    PoolTooYoung,
    DepthBelowMinimum,
    MoveBeyondPause,
    VolatilityBeyondPause,
    MoveDefensive,
    VolatilityDefensive,
    DepthDefensive
}

/// @notice Lifetime *net* sales unlock linearly from `releaseStart` over `releaseDuration` seconds.
struct ReleaseLimits {
    uint256 allotment;
    uint64 releaseStart;
    uint64 releaseDuration;
}

/// @notice Treasury-wide caps per period (periods counted from `releaseStart`).
struct PeriodLimits {
    uint64 periodLength;
    /// @dev Base sold per period, never reduced by buybacks.
    uint256 grossSellCap;
    /// @dev Base sold minus base bought back, per period.
    uint256 netSellCap;
    /// @dev Quote the treasury pays out per period (every buy, from any strategy). Zero means no buys.
    uint256 quoteSpendCap;
}

/// @notice Price rules applied to every fill.
struct PriceRules {
    /// @dev The treasury never sells below this execution price.
    uint256 floorPriceX36;
    /// @dev Max distance between a strategy's pre-trade price and the reference TWAP.
    uint16 maxQuoteDeviationBps;
    /// @dev Max price impact of one fill beyond the spread.
    uint16 maxImpactBps;
}

/// @notice How the oracle's readings become a risk mode.
struct OracleRules {
    /// @dev IMarketOracle for this policy's pair.
    address oracle;
    uint32 twapWindow;
    /// @dev Short TWAP window; its distance from the long TWAP is the volatility proxy. 0 < short ≤ twapWindow.
    uint32 shortWindow;
    /// @dev Band within which trusted depth is measured.
    uint16 depthBandBps;
    /// @dev Below either, the oracle is untrusted and the policy pauses.
    uint32 minPoolAge;
    uint256 minTrustedDepth;
    /// @dev Spot vs TWAP ("move") and short vs long TWAP ("volatility") thresholds; defensive ≤ pause.
    uint16 defensiveMoveBps;
    uint16 pauseMoveBps;
    uint16 defensiveVolatilityBps;
    uint16 pauseVolatilityBps;
    /// @dev Below this trusted depth the policy is defensive; ≥ minTrustedDepth.
    uint256 defensiveDepth;
}

/// @notice Limits in one risk mode. Defensive limits must be no looser than normal ones.
struct ModeLimits {
    /// @dev Max base per fill.
    uint256 maxFillBase;
    /// @dev Max base per fill as a share of the oracle's trusted depth.
    uint16 maxFillDepthBps;
    /// @dev Spread applied at least, whatever the strategy chose.
    uint16 minSpreadBps;
    bool buybacksAllowed;
}

/// @notice Everything an issuer decides for one base token in its Safe.
struct PolicyConfig {
    ReleaseLimits release;
    PeriodLimits period;
    PriceRules price;
    OracleRules oracle;
    ModeLimits normal;
    ModeLimits defensive;
}

/// @notice One treasury policy: every strategy selling or buying `base` from this Safe runs under it.
struct Policy {
    address safe;
    address base;
    address quote;
    Status status;
    PolicyConfig config;
}

/// @notice Limits of one strategy, set by the issuer.
struct StrategyBounds {
    uint16 spreadBpsMin;
    uint16 spreadBpsMax;
    uint256 maxShippedBase;
    uint256 maxShippedQuote;
    /// @dev Market maker's share of this strategy's fees. Fixed at creation.
    uint16 mmFeeShareBps;
    /// @dev Buyback strategies only: never buy above this price. Zero for market-making strategies.
    uint256 maxBuyPriceX36;
}

/// @notice Values the market maker tunes within the strategy's bounds.
struct StrategyParams {
    uint16 spreadBps;
    /// @dev Amounts shipped to Aqua for the active strategy version.
    uint256 shippedBase;
    uint256 shippedQuote;
}

/// @notice One Aqua strategy run by a market maker under a policy.
struct Strategy {
    bytes32 policyId;
    address mm;
    StrategyKind kind;
    Status status;
    /// @dev Aqua strategy hash currently shipped; only it may trade.
    bytes32 activeStrategyHash;
    StrategyBounds bounds;
    StrategyParams params;
}

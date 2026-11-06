// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// DRAFT: field set and layout are not final; they may change with client requirements.
// Keep MandateRegistry (Segment 4), MandateQuoter and the indexer schema in sync when editing.

/// @notice Lifecycle of a mandate. `None` means the id was never created.
enum MandateStatus {
    None,
    Active,
    Paused,
    Revoked
}

/// @notice Limits only the issuer (the Safe) can set. The market maker can never exceed them.
/// @dev Prices are `quoteRaw * 1e36 / baseRaw` (see MandateMath.PRICE_SCALE): a raw-unit ratio, so it is
///      independent of token decimals and keeps precision for very cheap tokens.
struct MandateBounds {
    /// @dev Max base tokens the strategy may ever sell, net of buybacks.
    uint256 allotment;
    /// @dev Sellable inventory unlocks linearly from `releaseStart` over `releaseDuration` seconds.
    uint64 releaseStart;
    uint64 releaseDuration;
    /// @dev Epoch length in seconds; epochs are counted from `releaseStart`.
    uint64 epochLength;
    /// @dev Ceiling on `MandateParams.epochCap`.
    uint256 maxEpochCap;
    /// @dev Ceiling on `MandateParams.shippedQuote`: quote tokens the issuer commits to buybacks.
    uint256 maxShippedQuote;
    /// @dev Never sell base below this price.
    uint256 floorPriceX36;
    /// @dev Max distance between execution price and the anchor TWAP.
    uint16 maxAnchorDeviationBps;
    /// @dev TWAP lookback passed to the anchor.
    uint32 twapWindow;
    /// @dev Range the market maker may choose `MandateParams.spreadBps` from.
    uint16 spreadBpsMin;
    uint16 spreadBpsMax;
    /// @dev Market maker's share of accrued fees, claimable by the market maker. Fixed at creation.
    uint16 mmFeeShareBps;
    /// @dev IPriceAnchor adapter for this mandate's pair.
    address anchor;
    /// @dev The only Extruction target strategies of this mandate may use. Set by the registry, not the issuer.
    address quoter;
}

/// @notice Values the market maker tunes, always validated against `MandateBounds`.
struct MandateParams {
    uint16 spreadBps;
    uint256 epochCap;
    /// @dev Amounts shipped to Aqua for the active strategy.
    uint256 shippedBase;
    uint256 shippedQuote;
}

/// @notice Full mandate as stored by the registry (MandateModule) and read by the quoter.
struct Mandate {
    /// @dev Issuer Safe: owner of the tokens and Aqua maker of every strategy.
    address safe;
    /// @dev Market maker operator address.
    address mm;
    /// @dev Token the treasury sells (e.g. LAUNCH).
    address base;
    /// @dev Token the treasury receives (e.g. USDC).
    address quote;
    MandateStatus status;
    /// @dev Aqua strategy hash currently shipped for this mandate; only it may trade.
    bytes32 activeStrategyHash;
    MandateBounds bounds;
    MandateParams params;
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Mandate, MandateBounds, MandateParams, MandateStatus } from "../../src/libraries/MandateTypes.sol";

/// @notice Default demo terms (spec §6.1): 10M LAUNCH over 180 days, 200k/day cap, $0.30 floor, 3% anchor band.
/// @dev Prices assume an 18-decimal base and a 6-decimal quote.
library MandateFixture {
    uint256 internal constant ALLOTMENT = 10_000_000e18;
    uint256 internal constant MAX_EPOCH_CAP = 200_000e18;
    uint256 internal constant FLOOR_X36 = 3e23; // 0.30 USDC per LAUNCH
    uint256 internal constant SPOT_X36 = 4e23; // 0.40 USDC per LAUNCH
    uint16 internal constant SPREAD_BPS = 30;
    uint256 internal constant MAX_SHIPPED_QUOTE = 5_000_000e6;

    function defaultMandate(
        address safe,
        address mm,
        address base,
        address quote,
        address anchor,
        address quoter,
        uint64 releaseStart
    )
        internal
        pure
        returns (Mandate memory)
    {
        return Mandate({
            safe: safe,
            mm: mm,
            base: base,
            quote: quote,
            status: MandateStatus.Active,
            activeStrategyHash: bytes32(0),
            bounds: MandateBounds({
                allotment: ALLOTMENT,
                releaseStart: releaseStart,
                releaseDuration: 180 days,
                epochLength: 1 days,
                maxEpochCap: MAX_EPOCH_CAP,
                maxShippedQuote: MAX_SHIPPED_QUOTE,
                floorPriceX36: FLOOR_X36,
                maxAnchorDeviationBps: 300,
                twapWindow: 30 minutes,
                spreadBpsMin: 10,
                spreadBpsMax: 200,
                mmFeeShareBps: 5000,
                anchor: anchor,
                quoter: quoter
            }),
            params: MandateParams({ spreadBps: SPREAD_BPS, epochCap: MAX_EPOCH_CAP, shippedBase: 0, shippedQuote: 0 })
        });
    }
}

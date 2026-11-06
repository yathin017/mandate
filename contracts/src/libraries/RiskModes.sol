// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMarketOracle } from "../interfaces/IMarketOracle.sol";
import { MandateMath } from "./MandateMath.sol";
import { OracleRules, RiskMode, RiskReason } from "./MandateTypes.sol";

/// @title RiskModes
/// @notice Turns the oracle's readings into the policy's risk mode, with the first rule that applied as the reason.
///         Order: an untrusted oracle pauses (unpriced, too young, too thin), then pause thresholds, then defensive
///         thresholds. Thresholds are "strictly beyond": a reading equal to a threshold does not trigger it.
/// @dev Pure, so the quote path, the swap path and the views always agree. The market maker has no input here.
library RiskModes {
    function evaluate(OracleRules memory r, IMarketOracle.Health memory h)
        internal
        pure
        returns (RiskMode, RiskReason)
    {
        if (!h.priced) return (RiskMode.Paused, RiskReason.Unpriced);
        if (h.poolAge < r.minPoolAge) return (RiskMode.Paused, RiskReason.PoolTooYoung);
        if (h.trustedDepthBase < r.minTrustedDepth) return (RiskMode.Paused, RiskReason.DepthBelowMinimum);

        uint256 move = MandateMath.deviationBps(h.spotX36, h.twapX36);
        uint256 volatility = MandateMath.deviationBps(h.shortTwapX36, h.twapX36);
        if (move > r.pauseMoveBps) return (RiskMode.Paused, RiskReason.MoveBeyondPause);
        if (volatility > r.pauseVolatilityBps) return (RiskMode.Paused, RiskReason.VolatilityBeyondPause);
        if (move > r.defensiveMoveBps) return (RiskMode.Defensive, RiskReason.MoveDefensive);
        if (volatility > r.defensiveVolatilityBps) return (RiskMode.Defensive, RiskReason.VolatilityDefensive);
        if (h.trustedDepthBase < r.defensiveDepth) return (RiskMode.Defensive, RiskReason.DepthDefensive);
        return (RiskMode.Normal, RiskReason.None);
    }
}

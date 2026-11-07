// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { RiskModes } from "../../src/libraries/RiskModes.sol";
import { OracleRules, RiskMode, RiskReason } from "../../src/libraries/MandateTypes.sol";

import { MandateFixture } from "../utils/MandateFixture.sol";

/// @notice Every branch of RiskModes.evaluate, at and just beyond each threshold, and the precedence between rules.
contract RiskModesTest is Test {
    uint256 internal constant P = 4e23;

    OracleRules internal rules;

    function setUp() public {
        rules = MandateFixture.policyConfig(address(1), 0).oracle;
    }

    function _healthy() internal pure returns (IMarketOracle.Health memory) {
        return IMarketOracle.Health({
            priced: true, spotX36: P, twapX36: P, shortTwapX36: P, trustedDepthBase: 1_000_000e18, poolAge: 1 days
        });
    }

    /// @dev Price `bps` basis points above P.
    function _up(uint256 bps) internal pure returns (uint256) {
        return P * (10_000 + bps) / 10_000;
    }

    function _check(IMarketOracle.Health memory h, RiskMode mode, RiskReason reason) internal view {
        (RiskMode m, RiskReason r) = RiskModes.evaluate(rules, h);
        assertEq(uint8(m), uint8(mode), "mode");
        assertEq(uint8(r), uint8(reason), "reason");
    }

    function test_healthy_isNormal() public view {
        _check(_healthy(), RiskMode.Normal, RiskReason.None);
    }

    function test_unpriced_pausesBeforeAnythingElse() public view {
        IMarketOracle.Health memory h = _healthy();
        h.priced = false;
        h.poolAge = 0;
        h.trustedDepthBase = 0;
        _check(h, RiskMode.Paused, RiskReason.Unpriced);
    }

    function test_poolAge_boundary() public view {
        IMarketOracle.Health memory h = _healthy();
        h.poolAge = rules.minPoolAge;
        _check(h, RiskMode.Normal, RiskReason.None);
        h.poolAge = rules.minPoolAge - 1;
        _check(h, RiskMode.Paused, RiskReason.PoolTooYoung);
    }

    function test_depth_pauseAndDefensiveBoundaries() public view {
        IMarketOracle.Health memory h = _healthy();
        h.trustedDepthBase = rules.minTrustedDepth - 1;
        _check(h, RiskMode.Paused, RiskReason.DepthBelowMinimum);
        h.trustedDepthBase = rules.minTrustedDepth;
        _check(h, RiskMode.Defensive, RiskReason.DepthDefensive);
        h.trustedDepthBase = rules.defensiveDepth;
        _check(h, RiskMode.Normal, RiskReason.None);
    }

    function test_move_boundaries() public view {
        IMarketOracle.Health memory h = _healthy();
        h.spotX36 = _up(rules.defensiveMoveBps);
        _check(h, RiskMode.Normal, RiskReason.None);
        h.spotX36 = _up(rules.defensiveMoveBps + 1);
        _check(h, RiskMode.Defensive, RiskReason.MoveDefensive);
        h.spotX36 = _up(rules.pauseMoveBps);
        _check(h, RiskMode.Defensive, RiskReason.MoveDefensive);
        h.spotX36 = _up(rules.pauseMoveBps + 1);
        _check(h, RiskMode.Paused, RiskReason.MoveBeyondPause);
    }

    function test_move_countsDownwardMovesToo() public view {
        IMarketOracle.Health memory h = _healthy();
        h.spotX36 = P * 8 / 10;
        _check(h, RiskMode.Paused, RiskReason.MoveBeyondPause);
    }

    function test_volatility_boundaries() public view {
        IMarketOracle.Health memory h = _healthy();
        h.shortTwapX36 = _up(rules.defensiveVolatilityBps);
        _check(h, RiskMode.Normal, RiskReason.None);
        h.shortTwapX36 = _up(rules.defensiveVolatilityBps + 1);
        _check(h, RiskMode.Defensive, RiskReason.VolatilityDefensive);
        h.shortTwapX36 = _up(rules.pauseVolatilityBps + 1);
        _check(h, RiskMode.Paused, RiskReason.VolatilityBeyondPause);
    }

    function test_pauseRules_winOverDefensiveRules() public view {
        IMarketOracle.Health memory h = _healthy();
        h.spotX36 = _up(rules.defensiveMoveBps + 1);
        h.shortTwapX36 = _up(rules.pauseVolatilityBps + 1);
        _check(h, RiskMode.Paused, RiskReason.VolatilityBeyondPause);
    }

    function testFuzz_neverNormalWhenAnyThresholdIsCrossed(uint256 spot, uint256 shortTwap, uint256 depth) public view {
        spot = bound(spot, 1e20, 1e26);
        shortTwap = bound(shortTwap, 1e20, 1e26);
        depth = bound(depth, 0, 1e30);
        IMarketOracle.Health memory h = _healthy();
        h.spotX36 = spot;
        h.shortTwapX36 = shortTwap;
        h.trustedDepthBase = depth;
        (RiskMode m,) = RiskModes.evaluate(rules, h);
        bool calm = _deviation(spot) <= rules.defensiveMoveBps && _deviation(shortTwap) <= rules.defensiveVolatilityBps
            && depth >= rules.defensiveDepth;
        assertEq(m == RiskMode.Normal, calm);
    }

    function _deviation(uint256 price) internal pure returns (uint256) {
        uint256 diff = price > P ? price - P : P - price;
        return (diff * 10_000 + P - 1) / P; // rounds up, as MandateMath.deviationBps does
    }
}

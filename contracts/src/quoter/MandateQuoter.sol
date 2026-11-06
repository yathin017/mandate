// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IMandateQuoter } from "../interfaces/IMandateQuoter.sol";
import { IMandateRegistry } from "../interfaces/IMandateRegistry.sol";
import { IMarketOracle } from "../interfaces/IMarketOracle.sol";
import { MandateMath } from "../libraries/MandateMath.sol";
import {
    ModeLimits,
    Policy,
    PolicyConfig,
    RiskMode,
    RiskReason,
    Status,
    Strategy,
    StrategyKind
} from "../libraries/MandateTypes.sol";
import { RiskModes } from "../libraries/RiskModes.sol";

/// @title MandateQuoter
/// @notice SwapVM Extruction target that prices every fill of a strategy's Aqua order and refuses any fill that breaks
///         its treasury policy. All of a policy's strategies share one set of counters, so caps are treasury-wide:
///         gross sells per period (never reduced by buybacks), net sells per period, quote spent per period, and
///         lifetime net sells against the release schedule. Counters belong to the policy, not to a strategy version,
///         so docking and reshipping never resets them.
///
///         Every fill first reads the policy's market oracle and derives a risk mode (RiskModes): Paused refuses,
///         Defensive applies the issuer's tighter limits (smaller fills, a higher minimum spread, optionally no buys),
///         Normal applies the normal ones. The market maker cannot choose the mode.
///
///         Price checks are split so ordinary impact on a large trade is not mistaken for an abusive quote: the
///         strategy's pre-trade price must be near the reference TWAP, and the fill may move away from it only by the
///         spread plus the policy's impact allowance; size is capped absolutely and as a share of trusted depth.
///
/// @dev Strategy program: `[salt, Extruction(this, abi.encodePacked(strategyId))]`. The quoter computes the missing
///      amount itself (constant product over the Aqua balances, spread taken from the input).
///
///      Quote/swap consistency: SwapVM calls `extruction` via STATICCALL on quote and via CALL on swap. Both run the
///      same `_evaluate` view; only the swap path then persists its result in `_apply`.
///
///      Trust model: non-upgradeable, no owner. Terms come from the immutable REGISTRY (MandateModule). State writes
///      require msg.sender == ROUTER, and every fill must come from the policy's Safe and the strategy's currently
///      shipped order, so no third-party order can consume a policy's capacity.
contract MandateQuoter is IExtruction, IMandateQuoter {
    using SafeCast for uint256;

    /// @dev Policy-wide counters. `periodIndex` gates the per-period ones.
    struct CounterState {
        uint64 periodIndex;
        uint192 grossSold;
        uint256 netSold;
        uint256 quoteSpent;
        uint256 totalNetSold;
    }

    struct FeeState {
        uint256 baseFees;
        uint256 quoteFees;
    }

    /// @dev Result of evaluating one fill, with counters as they will be after it.
    struct Fill {
        bool isSell;
        RiskMode mode;
        uint256 amountIn;
        uint256 amountOut;
        uint256 fee;
        uint256 priceX36;
        CounterState counters;
    }

    /// @notice AquaSwapVMRouter allowed to drive the state-writing path.
    address public immutable ROUTER;
    /// @notice Source of policy and strategy terms.
    IMandateRegistry public immutable REGISTRY;

    mapping(bytes32 policyId => CounterState) private _counters;
    mapping(bytes32 strategyId => FeeState) private _fees;

    error ZeroAddress();

    constructor(address router, IMandateRegistry registry) {
        require(router != address(0) && address(registry) != address(0), ZeroAddress());
        ROUTER = router;
        REGISTRY = registry;
    }

    // ================================================================ Extruction

    /// @inheritdoc IExtruction
    /// @dev Serves both IExtruction and IStaticExtruction (same selector). Never writes storage when
    ///      `isStaticContext` is true, which the router's STATICCALL on the quote path enforces anyway.
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData */
    )
        external
        returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap)
    {
        require(isStaticContext || msg.sender == ROUTER, NotRouter(msg.sender));
        require(args.length == 32, InvalidArgs());
        // casting to 'bytes32' is safe because args.length == 32 was checked above
        // forge-lint: disable-next-line(unsafe-typecast)
        bytes32 strategyId = bytes32(args);

        Strategy memory s = REGISTRY.getStrategy(strategyId);
        require(s.status != Status.None, StrategyNotFound(strategyId));
        Policy memory p = REGISTRY.getPolicy(s.policyId);
        Fill memory fill = _evaluate(p, s, query, swap);

        updatedSwap = swap;
        if (query.isExactIn) {
            updatedSwap.amountOut = fill.amountOut;
        } else {
            updatedSwap.amountIn = fill.amountIn;
        }

        if (!isStaticContext) _apply(s.policyId, strategyId, query, fill);
        return (nextPC, 0, updatedSwap);
    }

    // ================================================================ views

    /// @inheritdoc IMandateQuoter
    function policyCounters(bytes32 policyId) external view returns (PolicyCounters memory out) {
        Policy memory p = REGISTRY.getPolicy(policyId);
        if (p.status == Status.None) return out;
        CounterState memory c = _rolled(policyId, p.config);
        out.periodIndex = c.periodIndex;
        out.grossSold = c.grossSold;
        out.netSold = c.netSold;
        out.quoteSpent = c.quoteSpent;
        out.totalNetSold = c.totalNetSold;
        out.released = _released(p.config);
        out.periodEndsAt = MandateMath.epochEnd(p.config.release.releaseStart, p.config.period.periodLength, c.periodIndex);
    }

    /// @inheritdoc IMandateQuoter
    function riskMode(bytes32 policyId)
        external
        view
        returns (RiskMode mode, RiskReason reason, IMarketOracle.Health memory health)
    {
        Policy memory p = REGISTRY.getPolicy(policyId);
        if (p.status == Status.None) return (RiskMode.Paused, RiskReason.Unpriced, health);
        health = _health(p);
        (mode, reason) = RiskModes.evaluate(p.config.oracle, health);
    }

    /// @inheritdoc IMandateQuoter
    function feesAccrued(bytes32 strategyId) external view returns (uint256 baseFees, uint256 quoteFees) {
        FeeState memory f = _fees[strategyId];
        return (f.baseFees, f.quoteFees);
    }

    // ================================================================ rules

    /// @dev Prices the fill and runs every rule. Pure function of (state, block.timestamp, inputs), shared by the quote
    ///      and swap paths. Check order matches IMandateQuoter's error list.
    function _evaluate(Policy memory p, Strategy memory s, SwapQuery calldata query, SwapRegisters calldata swap)
        private
        view
        returns (Fill memory fill)
    {
        // Identity: only the policy's Safe, only the strategy's shipped order, only the policy's pair.
        require(query.maker == p.safe, WrongMaker(query.maker, p.safe));
        require(query.orderHash == s.activeStrategyHash, InactiveStrategy(query.orderHash, s.activeStrategyHash));
        if (query.tokenIn == p.quote && query.tokenOut == p.base) {
            fill.isSell = true;
        } else if (query.tokenIn != p.base || query.tokenOut != p.quote) {
            revert WrongPair(query.tokenIn, query.tokenOut);
        }

        // Statuses: the policy first (it covers every strategy), then the strategy.
        require(p.status != Status.Revoked, PolicyRevoked());
        require(p.status != Status.Paused, PolicyPaused());
        require(s.status != Status.Revoked, StrategyRevoked());
        require(s.status != Status.Paused, StrategyPaused());

        // Risk mode from the market, never from the market maker.
        IMarketOracle.Health memory health = _health(p);
        RiskReason reason;
        (fill.mode, reason) = RiskModes.evaluate(p.config.oracle, health);
        require(fill.mode != RiskMode.Paused, RiskPaused(reason));
        ModeLimits memory limits = fill.mode == RiskMode.Normal ? p.config.normal : p.config.defensive;

        _price(p.config, s, limits, health.twapX36, swap, query.isExactIn, fill);

        // Size: absolute and depth-relative limits of the current mode.
        uint256 baseAmount = fill.isSell ? fill.amountOut : fill.amountIn;
        uint256 maxBase = Math.min(limits.maxFillBase, Math.mulDiv(health.trustedDepthBase, limits.maxFillDepthBps, MandateMath.BPS));
        require(baseAmount <= maxBase, FillTooLarge(baseAmount, maxBase));

        fill.counters = _rolled(s.policyId, p.config);
        if (fill.isSell) {
            _checkSell(p.config, s, fill, baseAmount);
        } else {
            _checkBuy(p.config, s, limits, fill, baseAmount);
        }
    }

    /// @dev Spread (at least the mode's minimum), constant-product amounts, pre-trade deviation and impact.
    function _price(
        PolicyConfig memory c,
        Strategy memory s,
        ModeLimits memory limits,
        uint256 twapX36,
        SwapRegisters calldata swap,
        bool isExactIn,
        Fill memory fill
    )
        private
        pure
    {
        uint256 spread = Math.max(s.params.spreadBps, limits.minSpreadBps);
        if (isExactIn) {
            require(swap.amountOut == 0, AmountAlreadyComputed());
            fill.amountIn = swap.amountIn;
            (fill.amountOut, fill.fee) = MandateMath.amountOutForExactIn(swap.balanceIn, swap.balanceOut, swap.amountIn, spread);
        } else {
            require(swap.amountIn == 0, AmountAlreadyComputed());
            fill.amountOut = swap.amountOut;
            (fill.amountIn, fill.fee) = MandateMath.amountInForExactOut(swap.balanceIn, swap.balanceOut, swap.amountOut, spread);
        }
        // Prices as quote per base: on a sell the taker pays quote (in) for base (out); on a buy the reverse.
        uint256 preTradeX36 = fill.isSell
            ? MandateMath.price(swap.balanceOut, swap.balanceIn)
            : MandateMath.price(swap.balanceIn, swap.balanceOut);
        fill.priceX36 = fill.isSell
            ? MandateMath.price(fill.amountOut, fill.amountIn)
            : MandateMath.price(fill.amountIn, fill.amountOut);

        uint256 deviation = MandateMath.deviationBps(preTradeX36, twapX36);
        require(
            deviation <= c.price.maxQuoteDeviationBps,
            QuoteOffMarket(preTradeX36, twapX36, deviation, c.price.maxQuoteDeviationBps)
        );
        uint256 impact = MandateMath.deviationBps(fill.priceX36, preTradeX36);
        uint256 maxImpact = spread + c.price.maxImpactBps;
        require(impact <= maxImpact, PriceImpactTooHigh(fill.priceX36, preTradeX36, impact, maxImpact));
    }

    function _checkSell(PolicyConfig memory c, Strategy memory s, Fill memory fill, uint256 baseOut) private view {
        require(s.kind == StrategyKind.MarketMaking, SellsNotAllowed());
        require(fill.priceX36 >= c.price.floorPriceX36, BelowFloor(fill.priceX36, c.price.floorPriceX36));
        CounterState memory k = fill.counters;
        require(
            k.grossSold + baseOut <= c.period.grossSellCap,
            GrossSellCapReached(k.grossSold, baseOut, c.period.grossSellCap)
        );
        require(k.netSold + baseOut <= c.period.netSellCap, NetSellCapReached(k.netSold, baseOut, c.period.netSellCap));
        uint256 unlocked = _released(c);
        require(k.totalNetSold + baseOut <= unlocked, ReleaseExceeded(k.totalNetSold, baseOut, unlocked));
        k.grossSold = (uint256(k.grossSold) + baseOut).toUint192();
        k.netSold += baseOut;
        k.totalNetSold += baseOut;
    }

    function _checkBuy(
        PolicyConfig memory c,
        Strategy memory s,
        ModeLimits memory limits,
        Fill memory fill,
        uint256 baseIn
    )
        private
        pure
    {
        require(limits.buybacksAllowed, BuybacksNotAllowed(fill.mode));
        if (s.kind == StrategyKind.Buyback) {
            require(fill.priceX36 <= s.bounds.maxBuyPriceX36, AboveMaxBuyPrice(fill.priceX36, s.bounds.maxBuyPriceX36));
        }
        CounterState memory k = fill.counters;
        uint256 quoteOut = fill.amountOut;
        require(
            k.quoteSpent + quoteOut <= c.period.quoteSpendCap,
            QuoteSpendCapReached(k.quoteSpent, quoteOut, c.period.quoteSpendCap)
        );
        k.quoteSpent += quoteOut;
        // A buyback restores net capacity (never below zero); the gross counter never goes down.
        k.netSold = _saturatingSub(k.netSold, baseIn);
        k.totalNetSold = _saturatingSub(k.totalNetSold, baseIn);
    }

    /// @dev Persists an evaluated fill. Swap path only.
    function _apply(bytes32 policyId, bytes32 strategyId, SwapQuery calldata query, Fill memory fill) private {
        _counters[policyId] = fill.counters;
        if (fill.fee > 0) {
            // Fee is in tokenIn: quote on a sell, base on a buy.
            if (fill.isSell) {
                _fees[strategyId].quoteFees += fill.fee;
            } else {
                _fees[strategyId].baseFees += fill.fee;
            }
            emit FeeAccrued(strategyId, query.tokenIn, fill.fee);
        }
        emit Filled(
            policyId,
            strategyId,
            query.taker,
            query.orderHash,
            fill.isSell,
            fill.amountIn,
            fill.amountOut,
            fill.priceX36,
            fill.mode
        );
    }

    // ================================================================ helpers

    function _health(Policy memory p) private view returns (IMarketOracle.Health memory) {
        return IMarketOracle(p.config.oracle.oracle)
            .health(p.base, p.quote, p.config.oracle.twapWindow, p.config.oracle.shortWindow, p.config.oracle.depthBandBps);
    }

    /// @dev Stored counters with the per-period ones reset if a new period has started.
    function _rolled(bytes32 policyId, PolicyConfig memory c) private view returns (CounterState memory k) {
        k = _counters[policyId];
        uint256 index = MandateMath.epochIndex(c.release.releaseStart, c.period.periodLength, block.timestamp);
        if (index != k.periodIndex) {
            k.periodIndex = index.toUint64();
            k.grossSold = 0;
            k.netSold = 0;
            k.quoteSpent = 0;
        }
    }

    function _released(PolicyConfig memory c) private view returns (uint256) {
        return MandateMath.released(c.release.allotment, c.release.releaseStart, c.release.releaseDuration, block.timestamp);
    }

    function _saturatingSub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}

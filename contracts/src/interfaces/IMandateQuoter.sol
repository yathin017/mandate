// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IMarketOracle } from "./IMarketOracle.sol";
import { RiskMode, RiskReason } from "../libraries/MandateTypes.sol";

/// @title IMandateQuoter
/// @notice Errors, events and read views of MandateQuoter, the SwapVM Extruction target that prices every fill of a
///         strategy's Aqua order and refuses fills that break its policy. Counters are kept per **policy**, so every
///         strategy of a treasury shares one set of caps, and they survive reships and new strategies.
/// @dev Every error here needs a plain-language entry in the SDK error map.
interface IMandateQuoter {
    // ---------------------------------------------------------------- errors: caller / identity

    /// @notice State-writing path called by someone other than the AquaSwapVMRouter.
    error NotRouter(address caller);
    /// @notice Extruction args are not exactly one 32-byte strategy id.
    error InvalidArgs();
    error StrategyNotFound(bytes32 strategyId);
    /// @notice Order's maker is not the policy's Safe (someone pointed their own strategy at us).
    error WrongMaker(address maker, address safe);
    /// @notice Order is not the version the strategy currently has shipped.
    error InactiveStrategy(bytes32 orderHash, bytes32 activeStrategyHash);
    error WrongPair(address tokenIn, address tokenOut);
    /// @notice The output register was already filled by an earlier instruction.
    error AmountAlreadyComputed();

    // ---------------------------------------------------------------- errors: rules (checked in this order)

    error PolicyRevoked();
    error PolicyPaused();
    error StrategyRevoked();
    error StrategyPaused();
    /// @notice The oracle's readings put the policy in Paused mode.
    error RiskPaused(RiskReason reason);
    /// @notice The strategy's own price before the trade is too far from the reference TWAP.
    error QuoteOffMarket(uint256 preTradeX36, uint256 twapX36, uint256 deviationBps, uint256 maxDeviationBps);
    /// @notice The fill moves the price more than the spread plus the policy's impact allowance.
    error PriceImpactTooHigh(uint256 priceX36, uint256 preTradeX36, uint256 impactBps, uint256 maxImpactBps);
    /// @notice The fill's base amount exceeds the current mode's absolute or depth-relative limit.
    error FillTooLarge(uint256 baseAmount, uint256 maxBaseAmount);
    error SellsNotAllowed();
    error BelowFloor(uint256 priceX36, uint256 floorPriceX36);
    error GrossSellCapReached(uint256 sold, uint256 requested, uint256 cap);
    error NetSellCapReached(uint256 netSold, uint256 requested, uint256 cap);
    error ReleaseExceeded(uint256 totalNetSold, uint256 requested, uint256 released);
    error BuybacksNotAllowed(RiskMode mode);
    error AboveMaxBuyPrice(uint256 priceX36, uint256 maxBuyPriceX36);
    error QuoteSpendCapReached(uint256 spent, uint256 requested, uint256 cap);

    // ---------------------------------------------------------------- events

    /// @param isSell true when the treasury sold base (taker bought base)
    /// @param priceX36 execution price, `quoteRaw * 1e36 / baseRaw`
    event Filled(
        bytes32 indexed policyId,
        bytes32 indexed strategyId,
        address indexed taker,
        bytes32 strategyHash,
        bool isSell,
        uint256 amountIn,
        uint256 amountOut,
        uint256 priceX36,
        RiskMode mode
    );

    /// @notice Spread kept by the treasury on a fill, owed in part to the strategy's market maker.
    event FeeAccrued(bytes32 indexed strategyId, address indexed token, uint256 amount);

    // ---------------------------------------------------------------- views

    /// @notice Treasury-wide counters of a policy, rolled over if the stored period has ended.
    struct PolicyCounters {
        uint256 periodIndex;
        uint256 grossSold;
        uint256 netSold;
        uint256 quoteSpent;
        uint256 totalNetSold;
        uint256 released;
        uint256 periodEndsAt;
    }

    function policyCounters(bytes32 policyId) external view returns (PolicyCounters memory);

    /// @notice The policy's risk mode now, why, and the oracle readings behind it.
    function riskMode(bytes32 policyId)
        external
        view
        returns (RiskMode mode, RiskReason reason, IMarketOracle.Health memory health);

    /// @notice Total spread fees accrued by a strategy's fills, per token. Payout accounting lives in the registry.
    function feesAccrued(bytes32 strategyId) external view returns (uint256 baseFees, uint256 quoteFees);
}

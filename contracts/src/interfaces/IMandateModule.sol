// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { PolicyConfig, StrategyBounds, StrategyKind, StrategyParams } from "../libraries/MandateTypes.sol";
import { IMandateRegistry } from "./IMandateRegistry.sol";

/// @title IMandateModule
/// @notice Safe module that turns market-maker deals into enforced, revocable permissions over the issuer's Aqua
///         strategies. A Safe sets one **policy** per base token (its treasury-wide risk budget) and attaches
///         **strategies** to it, each run by a market maker. One module serves any number of Safes.
///
///         Roles:
///         - Issuer (the Safe itself, via its owners): create and update policies and strategies, pause, unpause,
///           revoke.
///         - Market maker of a strategy: reship it within its bounds, pause it, claim its fee share.
///         Nobody else can act. A market maker can never move tokens except its own earned fees.
/// @dev Every error here needs a plain-language entry in the SDK error map.
interface IMandateModule is IMandateRegistry {
    // ---------------------------------------------------------------- errors

    error NotIssuer(address caller);
    error NotMarketMaker(address caller);
    error NotIssuerOrMarketMaker(address caller);
    error ModuleNotEnabled(address safe);
    error InvalidParties();
    error PolicyAlreadyActive(bytes32 policyId);
    error InvalidPolicy(string field);
    error InvalidStrategy(string field);
    error ParamsOutOfBounds(string field);
    error FeeShareIsFixed(uint16 current, uint16 requested);
    error TooManyStrategies(uint256 limit);
    /// @notice The Safe's live strategies would need more of `token` than it holds.
    error InsufficientBacking(address token, uint256 committed, uint256 balance);
    error PolicyNotActive();
    error IsRevoked();
    error NotActive();
    error NotPaused();
    error NothingToClaim();
    error SafeCallFailed(address target, bytes returnData);

    // ---------------------------------------------------------------- events

    event PolicyCreated(bytes32 indexed policyId, address indexed safe, address indexed base, address quote);
    event PolicyUpdated(bytes32 indexed policyId, PolicyConfig config);
    event PolicyPaused(bytes32 indexed policyId);
    event PolicyUnpaused(bytes32 indexed policyId);
    event PolicyRevoked(bytes32 indexed policyId);

    event StrategyAdded(
        bytes32 indexed strategyId, bytes32 indexed policyId, address indexed mm, StrategyKind kind
    );
    event StrategyBoundsUpdated(bytes32 indexed strategyId, StrategyBounds bounds);
    event StrategyParamsUpdated(bytes32 indexed strategyId, StrategyParams params);
    event StrategyShipped(bytes32 indexed strategyId, bytes32 indexed strategyHash, uint256 nonce);
    event StrategyDocked(bytes32 indexed strategyId, bytes32 indexed strategyHash);
    event StrategyPaused(bytes32 indexed strategyId, address indexed by);
    event StrategyUnpaused(bytes32 indexed strategyId);
    /// @param docked false if the Safe refused the dock (e.g. module disabled); the quoter blocks fills regardless
    event StrategyRevoked(bytes32 indexed strategyId, bool docked);
    event FeesClaimed(bytes32 indexed strategyId, address indexed mm, uint256 baseAmount, uint256 quoteAmount);

    // ---------------------------------------------------------------- issuer (msg.sender is the Safe)

    /// @notice Creates the Safe's policy for `base` (one live policy per base token) and approves Aqua for both tokens.
    function createPolicy(address base, address quote, PolicyConfig calldata config) external returns (bytes32 policyId);

    /// @notice Replaces a policy's configuration (tighten or loosen; the owners approve either way).
    function updatePolicy(bytes32 policyId, PolicyConfig calldata config) external;

    function pausePolicy(bytes32 policyId) external;

    function unpausePolicy(bytes32 policyId) external;

    /// @notice Permanently ends the policy and revokes and docks every strategy under it. Cannot be blocked.
    function revokePolicy(bytes32 policyId) external;

    /// @notice Attaches a strategy run by `mm` to an active policy and ships its first Aqua order.
    function addStrategy(
        bytes32 policyId,
        address mm,
        StrategyKind kind,
        StrategyBounds calldata bounds,
        StrategyParams calldata params
    )
        external
        returns (bytes32 strategyId);

    /// @notice Replaces a strategy's bounds. Kind and fee share cannot change; the spread is clamped into the new range.
    function updateStrategyBounds(bytes32 strategyId, StrategyBounds calldata bounds) external;

    function unpauseStrategy(bytes32 strategyId) external;

    /// @notice Permanently ends a strategy and docks its order. Cannot be blocked.
    function revokeStrategy(bytes32 strategyId) external;

    // ---------------------------------------------------------------- market maker

    /// @notice Docks the strategy's order and ships a new one with `params`, validated against its bounds and backing.
    function reship(bytes32 strategyId, StrategyParams calldata params) external;

    /// @notice Claims the market maker's share of fees accrued so far. Allowed after revoke: earned pay stays earned.
    function claimFees(bytes32 strategyId) external returns (uint256 baseAmount, uint256 quoteAmount);

    // ---------------------------------------------------------------- issuer or market maker

    /// @notice Halts the strategy's fills. Its issuer or its market maker may pause; only the issuer may unpause.
    function pauseStrategy(bytes32 strategyId) external;

    // ---------------------------------------------------------------- views

    function policiesOf(address safe) external view returns (bytes32[] memory);

    /// @notice The Safe's live (not revoked) policy for `base`, or zero.
    function activePolicyOf(address safe, address base) external view returns (bytes32);

    function strategiesOf(bytes32 policyId) external view returns (bytes32[] memory);

    /// @notice The Safe's live strategies across all its policies (the set the backing check sums over).
    function liveStrategiesOf(address safe) external view returns (bytes32[] memory);

    /// @notice The order takers pass to the router to trade against the strategy's shipped version.
    function activeOrder(bytes32 strategyId) external view returns (ISwapVM.Order memory);

    function claimable(bytes32 strategyId) external view returns (uint256 baseAmount, uint256 quoteAmount);

    function claimed(bytes32 strategyId) external view returns (uint256 baseAmount, uint256 quoteAmount);
}

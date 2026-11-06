// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { MandateBounds, MandateParams } from "../libraries/MandateTypes.sol";
import { IMandateRegistry } from "./IMandateRegistry.sol";

/// @title IMandateModule
/// @notice Safe module that turns a market-maker deal into enforced, revocable permissions over the issuer's Aqua
///         strategy. One module serves any number of Safes; each Safe manages only its own mandates.
///
///         Roles per mandate:
///         - Issuer (the Safe itself, via its owners): create, update bounds, unpause, revoke.
///         - Market maker: reship within bounds, pause, claim its fee share.
///         Nobody else can act. The market maker can never move tokens except its own earned fees.
/// @dev Every error here needs a plain-language entry in the SDK error map.
interface IMandateModule is IMandateRegistry {
    // ---------------------------------------------------------------- errors

    error NotIssuer(address caller);
    error NotMarketMaker(address caller);
    error NotIssuerOrMarketMaker(address caller);
    error ModuleNotEnabled(address safe);
    error InvalidParties();
    error InvalidBounds(string field);
    error ParamsOutOfBounds(string field);
    error FeeShareIsFixed(uint16 current, uint16 requested);
    error MandateIsRevoked();
    error MandateNotActive();
    error MandateNotPaused();
    error NothingToClaim();
    error SafeCallFailed(address target, bytes returnData);

    // ---------------------------------------------------------------- events

    event MandateCreated(
        bytes32 indexed mandateId, address indexed safe, address indexed mm, address base, address quote
    );
    event StrategyShipped(bytes32 indexed mandateId, bytes32 indexed strategyHash, uint256 nonce);
    event StrategyDocked(bytes32 indexed mandateId, bytes32 indexed strategyHash);
    event ParamsUpdated(bytes32 indexed mandateId, MandateParams params);
    event BoundsUpdated(bytes32 indexed mandateId, MandateBounds bounds);
    event MandatePaused(bytes32 indexed mandateId, address indexed by);
    event MandateUnpaused(bytes32 indexed mandateId);
    /// @param docked false if the Safe refused the dock (e.g. module disabled); the quoter blocks fills regardless
    event MandateRevoked(bytes32 indexed mandateId, bool docked);
    event FeesClaimed(bytes32 indexed mandateId, address indexed mm, uint256 baseAmount, uint256 quoteAmount);

    // ---------------------------------------------------------------- issuer (msg.sender is the Safe)

    /// @notice Creates a mandate for the calling Safe, approves Aqua for both tokens and ships the first strategy.
    /// @dev `bounds.quoter` is ignored and set to this module's quoter.
    function createMandate(
        address mm,
        address base,
        address quote,
        MandateBounds calldata bounds,
        MandateParams calldata params
    )
        external
        returns (bytes32 mandateId);

    /// @notice Replaces the bounds. The fee share cannot change; live params are clamped into the new bounds.
    function updateBounds(bytes32 mandateId, MandateBounds calldata bounds) external;

    function unpause(bytes32 mandateId) external;

    /// @notice Permanently ends the mandate and docks its strategy. Cannot be blocked.
    function revoke(bytes32 mandateId) external;

    // ---------------------------------------------------------------- market maker

    /// @notice Docks the active strategy and ships a new one with `params`, all validated against the bounds.
    function reship(bytes32 mandateId, MandateParams calldata params) external;

    /// @notice Claims the market maker's share of fees accrued so far. Allowed after revoke: earned pay stays earned.
    function claimFees(bytes32 mandateId) external returns (uint256 baseAmount, uint256 quoteAmount);

    // ---------------------------------------------------------------- issuer or market maker

    /// @notice Halts fills. Either party may pause; only the issuer may unpause.
    function pause(bytes32 mandateId) external;

    // ---------------------------------------------------------------- views

    function mandatesOf(address safe) external view returns (bytes32[] memory);

    /// @notice The order takers pass to the router to trade against the active strategy.
    function activeOrder(bytes32 mandateId) external view returns (ISwapVM.Order memory);

    function claimable(bytes32 mandateId) external view returns (uint256 baseAmount, uint256 quoteAmount);

    function claimed(bytes32 mandateId) external view returns (uint256 baseAmount, uint256 quoteAmount);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IMandateQuoter
/// @notice Errors, events and read views of MandateQuoter, the SwapVM Extruction target that prices every
///         fill of a mandate's Aqua strategy and refuses fills that break the mandate's terms.
/// @dev Every error here needs a plain-language entry in the SDK error map.
interface IMandateQuoter {
    // ---------------------------------------------------------------- errors: caller / identity

    /// @notice State-writing path called by someone other than the AquaSwapVMRouter.
    error NotRouter(address caller);
    /// @notice Extruction args are not exactly one 32-byte mandate id.
    error InvalidArgs();
    error MandateNotFound(bytes32 mandateId);
    /// @notice Strategy's maker is not the mandate's Safe (someone pointed their own strategy at us).
    error WrongMaker(address maker, address safe);
    /// @notice Strategy is not the one the mandate currently has shipped.
    error InactiveStrategy(bytes32 orderHash, bytes32 activeStrategyHash);
    error WrongPair(address tokenIn, address tokenOut);
    /// @notice The output register was already filled by an earlier instruction.
    error AmountAlreadyComputed();

    // ---------------------------------------------------------------- errors: mandate rules (checked in this order)

    error MandateRevoked();
    error MandatePaused();
    error AnchorDeviation(uint256 priceX36, uint256 twapX36, uint256 deviationBps, uint256 maxDeviationBps);
    error BelowFloor(uint256 priceX36, uint256 floorPriceX36);
    error EpochCapReached(uint256 used, uint256 requested, uint256 cap);
    error ReleaseExceeded(uint256 totalNetSold, uint256 requested, uint256 released);

    // ---------------------------------------------------------------- events

    /// @param isSell true when the treasury sold base (taker bought base)
    /// @param priceX36 execution price, `quoteRaw * 1e36 / baseRaw`
    event Filled(
        bytes32 indexed mandateId,
        bytes32 indexed strategyHash,
        address indexed taker,
        bool isSell,
        uint256 amountIn,
        uint256 amountOut,
        uint256 priceX36,
        uint256 netSoldThisEpoch,
        uint256 totalNetSold
    );

    /// @notice Spread kept by the treasury on a fill, owed in part to the market maker.
    event FeeAccrued(bytes32 indexed mandateId, address indexed token, uint256 amount);

    // ---------------------------------------------------------------- views

    /// @notice Base tokens unlocked for selling so far.
    function released(bytes32 mandateId) external view returns (uint256);

    /// @notice Current epoch counters (rolled over if the stored epoch has ended).
    function epochState(bytes32 mandateId)
        external
        view
        returns (uint256 epochIndex, uint256 netSoldThisEpoch, uint256 totalNetSold);

    /// @notice Base still sellable this epoch under the epoch cap alone.
    function remainingThisEpoch(bytes32 mandateId) external view returns (uint256);

    /// @notice Base sellable right now: the tighter of the epoch cap and the release curve.
    function sellableNow(bytes32 mandateId) external view returns (uint256);

    /// @notice Timestamp the current epoch ends and the epoch counter resets.
    function epochResetsAt(bytes32 mandateId) external view returns (uint256);

    /// @notice Aqua spot price of the active strategy vs the anchor TWAP.
    function anchorStatus(bytes32 mandateId)
        external
        view
        returns (uint256 aquaSpotX36, uint256 twapX36, uint256 deviationBps, bool ok);

    /// @notice Total fees accrued by fills, per token. Payout accounting lives in the registry.
    function feesAccrued(bytes32 mandateId) external view returns (uint256 baseFees, uint256 quoteFees);
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IExtruction } from "@1inch/swap-vm/src/instructions/Extruction.sol";
import { SwapQuery, SwapRegisters } from "@1inch/swap-vm/src/libs/VM.sol";

import { IMandateQuoter } from "../interfaces/IMandateQuoter.sol";
import { IMandateRegistry } from "../interfaces/IMandateRegistry.sol";
import { IPriceAnchor } from "../interfaces/IPriceAnchor.sol";
import { Mandate, MandateStatus } from "../libraries/MandateTypes.sol";
import { MandateMath } from "../libraries/MandateMath.sol";

/// @title MandateQuoter
/// @notice SwapVM Extruction target that prices every fill of a mandate's Aqua strategy and reverts any fill
///         that breaks the mandate: wrong strategy, revoked/paused, off-anchor price, below floor, over the
///         epoch sell cap, or ahead of the release curve.
///
/// @dev Strategy program: `[Extruction(this, abi.encodePacked(mandateId))]`. The quoter computes the missing
///      amount itself (constant product over the Aqua balances, spread taken from the input), so no other
///      pricing instruction is needed.
///
///      Quote/swap consistency: SwapVM calls `extruction` via STATICCALL on quote and via CALL on swap. Both
///      run the same `_evaluate` view; only the swap path then persists its result in `_apply`.
///
///      Trust model: non-upgradeable, no owner. Terms are read from the immutable REGISTRY (MandateModule).
///      State writes require msg.sender == ROUTER, and every fill must come from the mandate's own Safe and
///      its currently shipped strategy, so no third-party strategy can consume a mandate's capacity.
contract MandateQuoter is IExtruction, IMandateQuoter {
    using SafeCast for uint256;

    /// @dev Per-mandate sell counters. One slot for the hot epoch fields.
    struct EpochState {
        uint64 epochIndex;
        uint192 netSoldThisEpoch;
        uint256 totalNetSold;
    }

    struct FeeState {
        uint256 baseFees;
        uint256 quoteFees;
    }

    /// @dev Result of evaluating one fill, with counters as they will be after the fill.
    struct Fill {
        bool isSell;
        uint256 amountIn;
        uint256 amountOut;
        uint256 fee;
        uint256 priceX36;
        uint256 epochIndex;
        uint256 netSoldThisEpoch;
        uint256 totalNetSold;
    }

    /// @notice AquaSwapVMRouter allowed to drive the state-writing path.
    address public immutable ROUTER;
    /// @notice Aqua registry the router settles through; used only by the `anchorStatus` view.
    IAqua public immutable AQUA;
    /// @notice Source of mandate terms.
    IMandateRegistry public immutable REGISTRY;

    mapping(bytes32 mandateId => EpochState) private _epochs;
    mapping(bytes32 mandateId => FeeState) private _fees;

    error ZeroAddress();

    constructor(address router, IAqua aqua, IMandateRegistry registry) {
        require(router != address(0) && address(aqua) != address(0) && address(registry) != address(0), ZeroAddress());
        ROUTER = router;
        AQUA = aqua;
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
        // 1. NotRouter: only the router may drive a fill that writes state.
        require(isStaticContext || msg.sender == ROUTER, NotRouter(msg.sender));
        require(args.length == 32, InvalidArgs());
        bytes32 mandateId = bytes32(args);

        Mandate memory m = _getMandate(mandateId);
        Fill memory fill = _evaluate(mandateId, m, query, swap);

        updatedSwap = swap;
        if (query.isExactIn) {
            updatedSwap.amountOut = fill.amountOut;
        } else {
            updatedSwap.amountIn = fill.amountIn;
        }

        if (!isStaticContext) {
            _apply(mandateId, query, fill);
        }
        return (nextPC, 0, updatedSwap);
    }

    // ================================================================ views

    /// @inheritdoc IMandateQuoter
    function released(bytes32 mandateId) external view returns (uint256) {
        return _released(_getMandate(mandateId));
    }

    /// @inheritdoc IMandateQuoter
    function epochState(bytes32 mandateId)
        external
        view
        returns (uint256 epochIndex, uint256 netSoldThisEpoch, uint256 totalNetSold)
    {
        return _rolledEpoch(mandateId, _getMandate(mandateId));
    }

    /// @inheritdoc IMandateQuoter
    function remainingThisEpoch(bytes32 mandateId) public view returns (uint256) {
        Mandate memory m = _getMandate(mandateId);
        (, uint256 net,) = _rolledEpoch(mandateId, m);
        return _saturatingSub(_epochCap(m), net);
    }

    /// @inheritdoc IMandateQuoter
    function sellableNow(bytes32 mandateId) external view returns (uint256) {
        Mandate memory m = _getMandate(mandateId);
        (, uint256 net, uint256 total) = _rolledEpoch(mandateId, m);
        return Math.min(_saturatingSub(_epochCap(m), net), _saturatingSub(_released(m), total));
    }

    /// @inheritdoc IMandateQuoter
    function epochResetsAt(bytes32 mandateId) external view returns (uint256) {
        Mandate memory m = _getMandate(mandateId);
        uint256 index = MandateMath.epochIndex(m.bounds.releaseStart, m.bounds.epochLength, block.timestamp);
        return MandateMath.epochEnd(m.bounds.releaseStart, m.bounds.epochLength, index);
    }

    /// @inheritdoc IMandateQuoter
    /// @dev Reverts if the mandate has no active strategy or the anchor cannot price.
    function anchorStatus(bytes32 mandateId)
        external
        view
        returns (uint256 aquaSpotX36, uint256 twapX36, uint256 deviationBps, bool ok)
    {
        Mandate memory m = _getMandate(mandateId);
        (uint256 baseBalance, uint256 quoteBalance) =
            AQUA.safeBalances(m.safe, ROUTER, m.activeStrategyHash, m.base, m.quote);
        aquaSpotX36 = MandateMath.price(baseBalance, quoteBalance);
        twapX36 = IPriceAnchor(m.bounds.anchor).consult(m.base, m.quote, m.bounds.twapWindow);
        deviationBps = MandateMath.deviationBps(aquaSpotX36, twapX36);
        ok = deviationBps <= m.bounds.maxAnchorDeviationBps;
    }

    /// @inheritdoc IMandateQuoter
    function feesAccrued(bytes32 mandateId) external view returns (uint256 baseFees, uint256 quoteFees) {
        FeeState memory f = _fees[mandateId];
        return (f.baseFees, f.quoteFees);
    }

    // ================================================================ rules

    /// @dev Prices the fill and runs every rule. Pure function of (state, block.timestamp, inputs), shared by
    ///      the quote and swap paths. Check order matches IMandateQuoter's error list.
    function _evaluate(
        bytes32 mandateId,
        Mandate memory m,
        SwapQuery calldata query,
        SwapRegisters calldata swap
    )
        private
        view
        returns (Fill memory fill)
    {
        // Identity: only the mandate's Safe, only its active strategy, only its pair.
        require(query.maker == m.safe, WrongMaker(query.maker, m.safe));
        require(query.orderHash == m.activeStrategyHash, InactiveStrategy(query.orderHash, m.activeStrategyHash));
        if (query.tokenIn == m.quote && query.tokenOut == m.base) {
            fill.isSell = true;
        } else if (query.tokenIn != m.base || query.tokenOut != m.quote) {
            revert WrongPair(query.tokenIn, query.tokenOut);
        }

        // 2. MandateRevoked / MandatePaused
        require(m.status != MandateStatus.Revoked, MandateRevoked());
        require(m.status != MandateStatus.Paused, MandatePaused());

        // Price the fill over the strategy's Aqua balances (pre-loaded into the registers by the router).
        uint256 spread = m.params.spreadBps;
        if (query.isExactIn) {
            require(swap.amountOut == 0, AmountAlreadyComputed());
            fill.amountIn = swap.amountIn;
            (fill.amountOut, fill.fee) =
                MandateMath.amountOutForExactIn(swap.balanceIn, swap.balanceOut, swap.amountIn, spread);
        } else {
            require(swap.amountIn == 0, AmountAlreadyComputed());
            fill.amountOut = swap.amountOut;
            (fill.amountIn, fill.fee) =
                MandateMath.amountInForExactOut(swap.balanceIn, swap.balanceOut, swap.amountOut, spread);
        }
        fill.priceX36 = fill.isSell
            ? MandateMath.price(fill.amountOut, fill.amountIn)
            : MandateMath.price(fill.amountIn, fill.amountOut);

        // 3. AnchorDeviation: both directions, against the execution price.
        uint256 twapX36 = IPriceAnchor(m.bounds.anchor).consult(m.base, m.quote, m.bounds.twapWindow);
        uint256 deviation = MandateMath.deviationBps(fill.priceX36, twapX36);
        require(
            deviation <= m.bounds.maxAnchorDeviationBps,
            AnchorDeviation(fill.priceX36, twapX36, deviation, m.bounds.maxAnchorDeviationBps)
        );

        (fill.epochIndex, fill.netSoldThisEpoch, fill.totalNetSold) = _rolledEpoch(mandateId, m);

        if (fill.isSell) {
            // 4. BelowFloor
            require(fill.priceX36 >= m.bounds.floorPriceX36, BelowFloor(fill.priceX36, m.bounds.floorPriceX36));

            // 5. EpochCapReached
            uint256 cap = _epochCap(m);
            require(
                fill.netSoldThisEpoch + fill.amountOut <= cap,
                EpochCapReached(fill.netSoldThisEpoch, fill.amountOut, cap)
            );

            // 6. ReleaseExceeded
            uint256 unlocked = _released(m);
            require(
                fill.totalNetSold + fill.amountOut <= unlocked,
                ReleaseExceeded(fill.totalNetSold, fill.amountOut, unlocked)
            );

            fill.netSoldThisEpoch += fill.amountOut;
            fill.totalNetSold += fill.amountOut;
        } else {
            // Buyback restores capacity, never below zero.
            fill.netSoldThisEpoch = _saturatingSub(fill.netSoldThisEpoch, fill.amountIn);
            fill.totalNetSold = _saturatingSub(fill.totalNetSold, fill.amountIn);
        }
    }

    /// @dev Persists an evaluated fill. Swap path only.
    function _apply(bytes32 mandateId, SwapQuery calldata query, Fill memory fill) private {
        _epochs[mandateId] = EpochState({
            epochIndex: fill.epochIndex.toUint64(),
            netSoldThisEpoch: fill.netSoldThisEpoch.toUint192(),
            totalNetSold: fill.totalNetSold
        });

        if (fill.fee > 0) {
            // Fee is in tokenIn: quote on a sell, base on a buyback.
            if (fill.isSell) {
                _fees[mandateId].quoteFees += fill.fee;
            } else {
                _fees[mandateId].baseFees += fill.fee;
            }
            emit FeeAccrued(mandateId, query.tokenIn, fill.fee);
        }

        emit Filled(
            mandateId,
            query.orderHash,
            query.taker,
            fill.isSell,
            fill.amountIn,
            fill.amountOut,
            fill.priceX36,
            fill.netSoldThisEpoch,
            fill.totalNetSold
        );
    }

    // ================================================================ helpers

    function _getMandate(bytes32 mandateId) private view returns (Mandate memory m) {
        m = REGISTRY.getMandate(mandateId);
        require(m.status != MandateStatus.None, MandateNotFound(mandateId));
    }

    /// @dev Stored counters, with the epoch counter reset if a new epoch has started.
    function _rolledEpoch(
        bytes32 mandateId,
        Mandate memory m
    )
        private
        view
        returns (uint256 epochIndex, uint256 netSoldThisEpoch, uint256 totalNetSold)
    {
        EpochState memory s = _epochs[mandateId];
        epochIndex = MandateMath.epochIndex(m.bounds.releaseStart, m.bounds.epochLength, block.timestamp);
        netSoldThisEpoch = s.epochIndex == epochIndex ? s.netSoldThisEpoch : 0;
        totalNetSold = s.totalNetSold;
    }

    /// @dev MM-chosen cap, clamped to the issuer's ceiling as defence in depth (the registry also enforces it).
    function _epochCap(Mandate memory m) private pure returns (uint256) {
        return Math.min(m.params.epochCap, m.bounds.maxEpochCap);
    }

    function _released(Mandate memory m) private view returns (uint256) {
        return
            MandateMath.released(m.bounds.allotment, m.bounds.releaseStart, m.bounds.releaseDuration, block.timestamp);
    }

    function _saturatingSub(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
    }
}

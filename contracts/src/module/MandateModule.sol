// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";

import { IMandateModule } from "../interfaces/IMandateModule.sol";
import { IMandateRegistry } from "../interfaces/IMandateRegistry.sol";
import { ISafe } from "../interfaces/ISafe.sol";
import { Mandate, MandateBounds, MandateParams, MandateStatus } from "../libraries/MandateTypes.sol";
import { MandateStrategy } from "../libraries/MandateStrategy.sol";
import { MandateQuoter } from "../quoter/MandateQuoter.sol";

/// @title MandateModule
/// @notice Safe module and mandate registry. A project's Safe enables it once, then creates mandates that let a
///         market maker run an Aqua strategy over the Safe's tokens without ever holding them.
///
///         What the module can make a Safe do, exhaustively:
///         1. `approve(Aqua, max)` on the mandate's two tokens (on create).
///         2. `Aqua.ship` / `Aqua.dock` of this mandate's strategy on the AquaSwapVMRouter (create, reship, revoke).
///         3. `transfer(mm, amount)` of the market maker's earned fee share, capped by the quoter's fee accounting.
///         Nothing else: no arbitrary calls, no delegatecall, no other recipients.
///
/// @dev Deploys its own MandateQuoter so the quoter↔registry link is fixed at construction and cannot be
///      misconfigured. Non-upgradeable, no owner. One module serves every Safe on the chain.
contract MandateModule is IMandateModule, ReentrancyGuardTransient {
    uint256 private constant BPS = 10_000;

    struct Claimed {
        uint256 base;
        uint256 quote;
    }

    /// @notice AquaSwapVMRouter every strategy is shipped to.
    address public immutable ROUTER;
    IAqua public immutable AQUA;
    /// @notice The only quoter mandates of this module use; it reads its terms from this module.
    MandateQuoter public immutable QUOTER;

    mapping(bytes32 mandateId => Mandate) private _mandates;
    /// @notice Salt of the active strategy; incremented on every ship since Aqua never re-ships a docked hash.
    mapping(bytes32 mandateId => uint256) public strategyNonce;
    mapping(bytes32 mandateId => Claimed) private _claimed;
    mapping(address safe => bytes32[]) private _mandatesOf;
    /// @notice Per-Safe counter that makes mandate ids unique.
    mapping(address safe => uint256) public mandateCount;

    constructor(address router, IAqua aqua) {
        require(router != address(0) && address(aqua) != address(0), InvalidParties());
        ROUTER = router;
        AQUA = aqua;
        QUOTER = new MandateQuoter(router, aqua, IMandateRegistry(address(this)));
    }

    // ================================================================ modifiers

    modifier onlyIssuer(bytes32 mandateId) {
        require(msg.sender == _mandates[mandateId].safe, NotIssuer(msg.sender));
        _;
    }

    modifier onlyMarketMaker(bytes32 mandateId) {
        require(msg.sender == _mandates[mandateId].mm, NotMarketMaker(msg.sender));
        _;
    }

    // ================================================================ issuer

    /// @inheritdoc IMandateModule
    function createMandate(
        address mm,
        address base,
        address quote,
        MandateBounds calldata bounds,
        MandateParams calldata params
    )
        external
        nonReentrant
        returns (bytes32 mandateId)
    {
        address safe = msg.sender;
        require(ISafe(safe).isModuleEnabled(address(this)), ModuleNotEnabled(safe));
        require(
            mm != address(0) && mm != safe && base != address(0) && quote != address(0) && base != quote,
            InvalidParties()
        );
        _validateBounds(bounds);

        mandateId = keccak256(abi.encode(block.chainid, address(this), safe, mandateCount[safe]++));
        Mandate storage m = _mandates[mandateId];
        m.safe = safe;
        m.mm = mm;
        m.base = base;
        m.quote = quote;
        m.status = MandateStatus.Active;
        m.bounds = bounds;
        m.bounds.quoter = address(QUOTER);
        _validateParams(m, params, 0);
        m.params = params;
        _mandatesOf[safe].push(mandateId);

        emit MandateCreated(mandateId, safe, mm, base, quote);
        emit BoundsUpdated(mandateId, m.bounds);

        _approveAqua(safe, base);
        _approveAqua(safe, quote);
        _ship(mandateId, m);
    }

    /// @inheritdoc IMandateModule
    function updateBounds(bytes32 mandateId, MandateBounds calldata bounds)
        external
        nonReentrant
        onlyIssuer(mandateId)
    {
        Mandate storage m = _mandates[mandateId];
        require(m.status != MandateStatus.Revoked, MandateIsRevoked());
        require(
            bounds.mmFeeShareBps == m.bounds.mmFeeShareBps,
            FeeShareIsFixed(m.bounds.mmFeeShareBps, bounds.mmFeeShareBps)
        );
        _validateBounds(bounds);

        m.bounds = bounds;
        m.bounds.quoter = address(QUOTER);
        // Keep the live strategy inside the new rails; shipped amounts are re-checked on the next reship.
        // casting to 'uint16' is safe because the value is clamped between two uint16 bounds
        // forge-lint: disable-next-line(unsafe-typecast)
        m.params.spreadBps = uint16(Math.min(Math.max(m.params.spreadBps, bounds.spreadBpsMin), bounds.spreadBpsMax));
        m.params.epochCap = Math.min(m.params.epochCap, bounds.maxEpochCap);

        emit BoundsUpdated(mandateId, m.bounds);
        emit ParamsUpdated(mandateId, m.params);
    }

    /// @inheritdoc IMandateModule
    function unpause(bytes32 mandateId) external onlyIssuer(mandateId) {
        Mandate storage m = _mandates[mandateId];
        require(m.status == MandateStatus.Paused, MandateNotPaused());
        m.status = MandateStatus.Active;
        emit MandateUnpaused(mandateId);
    }

    /// @inheritdoc IMandateModule
    /// @dev Status flips first, so the quoter refuses every fill even if docking fails (e.g. the Safe already
    ///      disabled this module). Docking is best effort and never reverts the revoke.
    function revoke(bytes32 mandateId) external nonReentrant onlyIssuer(mandateId) {
        Mandate storage m = _mandates[mandateId];
        require(m.status != MandateStatus.Revoked, MandateIsRevoked());
        m.status = MandateStatus.Revoked;

        bool docked;
        try ISafe(m.safe)
            .execTransactionFromModuleReturnData(address(AQUA), 0, _dockCalldata(m), ISafe.Operation.Call) returns (
            bool success, bytes memory
        ) {
            docked = success;
        } catch { }
        if (docked) emit StrategyDocked(mandateId, m.activeStrategyHash);
        emit MandateRevoked(mandateId, docked);
    }

    // ================================================================ market maker

    /// @inheritdoc IMandateModule
    function reship(bytes32 mandateId, MandateParams calldata params) external nonReentrant onlyMarketMaker(mandateId) {
        Mandate storage m = _mandates[mandateId];
        require(m.status != MandateStatus.Revoked, MandateIsRevoked());
        (,, uint256 totalNetSold) = QUOTER.epochState(mandateId);
        _validateParams(m, params, totalNetSold);

        _exec(m.safe, address(AQUA), _dockCalldata(m));
        emit StrategyDocked(mandateId, m.activeStrategyHash);

        m.params = params;
        emit ParamsUpdated(mandateId, params);
        _ship(mandateId, m);
    }

    /// @inheritdoc IMandateModule
    function claimFees(bytes32 mandateId)
        external
        nonReentrant
        onlyMarketMaker(mandateId)
        returns (uint256 baseAmount, uint256 quoteAmount)
    {
        Mandate storage m = _mandates[mandateId];
        (baseAmount, quoteAmount) = _claimable(mandateId, m);
        require(baseAmount > 0 || quoteAmount > 0, NothingToClaim());

        Claimed storage c = _claimed[mandateId];
        c.base += baseAmount;
        c.quote += quoteAmount;
        emit FeesClaimed(mandateId, m.mm, baseAmount, quoteAmount);

        if (baseAmount > 0) _transferFromSafe(m.safe, m.base, m.mm, baseAmount);
        if (quoteAmount > 0) _transferFromSafe(m.safe, m.quote, m.mm, quoteAmount);
    }

    // ================================================================ either party

    /// @inheritdoc IMandateModule
    function pause(bytes32 mandateId) external {
        Mandate storage m = _mandates[mandateId];
        require(msg.sender == m.safe || msg.sender == m.mm, NotIssuerOrMarketMaker(msg.sender));
        require(m.status == MandateStatus.Active, MandateNotActive());
        m.status = MandateStatus.Paused;
        emit MandatePaused(mandateId, msg.sender);
    }

    // ================================================================ views

    /// @inheritdoc IMandateRegistry
    function getMandate(bytes32 mandateId) external view returns (Mandate memory) {
        return _mandates[mandateId];
    }

    /// @inheritdoc IMandateModule
    function mandatesOf(address safe) external view returns (bytes32[] memory) {
        return _mandatesOf[safe];
    }

    /// @inheritdoc IMandateModule
    function activeOrder(bytes32 mandateId) public view returns (ISwapVM.Order memory) {
        return MandateStrategy.order(_mandates[mandateId].safe, address(QUOTER), mandateId, strategyNonce[mandateId]);
    }

    /// @inheritdoc IMandateModule
    function claimable(bytes32 mandateId) external view returns (uint256 baseAmount, uint256 quoteAmount) {
        return _claimable(mandateId, _mandates[mandateId]);
    }

    /// @inheritdoc IMandateModule
    function claimed(bytes32 mandateId) external view returns (uint256 baseAmount, uint256 quoteAmount) {
        Claimed memory c = _claimed[mandateId];
        return (c.base, c.quote);
    }

    // ================================================================ validation

    function _validateBounds(MandateBounds calldata b) private pure {
        require(b.allotment > 0, InvalidBounds("allotment"));
        require(b.epochLength > 0, InvalidBounds("epochLength"));
        require(b.maxEpochCap > 0, InvalidBounds("maxEpochCap"));
        require(b.maxShippedQuote > 0, InvalidBounds("maxShippedQuote"));
        require(b.twapWindow > 0, InvalidBounds("twapWindow"));
        require(b.anchor != address(0), InvalidBounds("anchor"));
        require(b.maxAnchorDeviationBps <= BPS, InvalidBounds("maxAnchorDeviationBps"));
        require(b.spreadBpsMin <= b.spreadBpsMax, InvalidBounds("spreadBpsMin"));
        // A fill's spread alone must never push it outside the anchor band.
        require(b.spreadBpsMax < b.maxAnchorDeviationBps, InvalidBounds("spreadBpsMax"));
        require(b.mmFeeShareBps <= BPS, InvalidBounds("mmFeeShareBps"));
    }

    function _validateParams(Mandate storage m, MandateParams calldata p, uint256 totalNetSold) private view {
        MandateBounds storage b = m.bounds;
        require(p.spreadBps >= b.spreadBpsMin && p.spreadBps <= b.spreadBpsMax, ParamsOutOfBounds("spreadBps"));
        require(p.epochCap <= b.maxEpochCap, ParamsOutOfBounds("epochCap"));
        uint256 unsold = b.allotment > totalNetSold ? b.allotment - totalNetSold : 0;
        require(p.shippedBase > 0 && p.shippedBase <= unsold, ParamsOutOfBounds("shippedBase"));
        require(p.shippedQuote > 0 && p.shippedQuote <= b.maxShippedQuote, ParamsOutOfBounds("shippedQuote"));
    }

    // ================================================================ Safe actions

    function _ship(bytes32 mandateId, Mandate storage m) private {
        uint256 nonce = ++strategyNonce[mandateId];
        bytes memory strategy = abi.encode(MandateStrategy.order(m.safe, address(QUOTER), mandateId, nonce));
        (address[] memory tokens, uint256[] memory amounts) = _tokensAndAmounts(m);

        _exec(m.safe, address(AQUA), abi.encodeCall(IAqua.ship, (ROUTER, strategy, tokens, amounts)));
        m.activeStrategyHash = keccak256(strategy);
        emit StrategyShipped(mandateId, m.activeStrategyHash, nonce);
    }

    function _dockCalldata(Mandate storage m) private view returns (bytes memory) {
        (address[] memory tokens,) = _tokensAndAmounts(m);
        return abi.encodeCall(IAqua.dock, (ROUTER, m.activeStrategyHash, tokens));
    }

    function _tokensAndAmounts(Mandate storage m)
        private
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        tokens = new address[](2);
        tokens[0] = m.base;
        tokens[1] = m.quote;
        amounts = new uint256[](2);
        amounts[0] = m.params.shippedBase;
        amounts[1] = m.params.shippedQuote;
    }

    /// @dev Aqua pulls on fill, so the Safe must allow it. Resets to zero first for tokens like USDT.
    function _approveAqua(address safe, address token) private {
        uint256 current = IERC20(token).allowance(safe, address(AQUA));
        if (current == type(uint256).max) return;
        if (current != 0) _execToken(safe, token, abi.encodeCall(IERC20.approve, (address(AQUA), 0)));
        _execToken(safe, token, abi.encodeCall(IERC20.approve, (address(AQUA), type(uint256).max)));
    }

    function _transferFromSafe(address safe, address token, address to, uint256 amount) private {
        _execToken(safe, token, abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    /// @dev ERC20 call through the Safe that also accepts tokens returning no value.
    function _execToken(address safe, address token, bytes memory data) private {
        bytes memory ret = _exec(safe, token, data);
        require(ret.length == 0 || abi.decode(ret, (bool)), SafeCallFailed(token, ret));
    }

    /// @dev Plain CALL from the Safe; never DELEGATECALL.
    function _exec(address safe, address to, bytes memory data) private returns (bytes memory ret) {
        bool success;
        (success, ret) = ISafe(safe).execTransactionFromModuleReturnData(to, 0, data, ISafe.Operation.Call);
        require(success, SafeCallFailed(to, ret));
    }

    function _claimable(
        bytes32 mandateId,
        Mandate storage m
    )
        private
        view
        returns (uint256 baseAmount, uint256 quoteAmount)
    {
        if (m.status == MandateStatus.None) return (0, 0);
        (uint256 baseFees, uint256 quoteFees) = QUOTER.feesAccrued(mandateId);
        Claimed memory c = _claimed[mandateId];
        uint256 share = m.bounds.mmFeeShareBps;
        baseAmount = Math.mulDiv(baseFees, share, BPS) - c.base;
        quoteAmount = Math.mulDiv(quoteFees, share, BPS) - c.quote;
    }
}

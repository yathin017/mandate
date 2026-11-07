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
import {
    ModeLimits,
    Policy,
    PolicyConfig,
    Status,
    Strategy,
    StrategyBounds,
    StrategyKind,
    StrategyParams
} from "../libraries/MandateTypes.sol";
import { MandateStrategy } from "../libraries/MandateStrategy.sol";
import { MandateQuoter } from "../quoter/MandateQuoter.sol";

/// @title MandateModule
/// @notice Safe module and registry of treasury policies and their strategies. A project's Safe enables it once, sets
///         a policy per base token (its treasury-wide risk budget) and attaches strategies that let market makers run
///         Aqua orders over the Safe's tokens without ever holding them.
///
///         What the module can make a Safe do, exhaustively:
///         1. `approve(Aqua, max)` on a policy's two tokens (on policy creation).
///         2. `Aqua.ship` / `Aqua.dock` of its strategies' orders on the AquaSwapVMRouter.
///         3. `transfer(mm, amount)` of a market maker's earned fee share, capped by the quoter's fee accounting.
///         Nothing else: no arbitrary calls, no delegatecall, no other recipients.
///
///         Backing: Aqua balances are virtual, so every ship checks that, per token, the current Aqua balances of all
///         the Safe's live strategies do not exceed what the Safe actually holds.
///
/// @dev Deploys its own MandateQuoter so the quoter↔registry link is fixed at construction. Non-upgradeable, no owner.
///      Array caps bound the backing loop's gas; they are technical limits, not economic ones.
contract MandateModule is IMandateModule, ReentrancyGuardTransient {
    uint256 private constant BPS = 10_000;
    /// @notice Most strategies one policy may ever have (live or not).
    uint256 public constant MAX_STRATEGIES_PER_POLICY = 16;
    /// @notice Most live strategies one Safe may run at once, across its policies.
    uint256 public constant MAX_LIVE_STRATEGIES_PER_SAFE = 16;

    struct Claimed {
        uint256 base;
        uint256 quote;
    }

    /// @notice AquaSwapVMRouter every strategy is shipped to.
    address public immutable ROUTER;
    IAqua public immutable AQUA;
    /// @notice The only quoter strategies of this module use; it reads its terms from this module.
    MandateQuoter public immutable QUOTER;

    mapping(bytes32 policyId => Policy) private _policies;
    mapping(address safe => bytes32[]) private _policiesOf;
    mapping(address safe => mapping(address base => bytes32 policyId)) private _activePolicyOf;
    /// @notice Per-Safe counter that makes policy ids unique.
    mapping(address safe => uint256) public policyCount;

    mapping(bytes32 strategyId => Strategy) private _strategies;
    mapping(bytes32 policyId => bytes32[]) private _strategiesOf;
    mapping(address safe => bytes32[]) private _liveStrategiesOf;
    /// @notice Salt of the active order; incremented on every ship since Aqua never re-ships a docked hash.
    mapping(bytes32 strategyId => uint256) public strategyNonce;
    mapping(bytes32 strategyId => Claimed) private _claimed;

    constructor(address router, IAqua aqua) {
        require(router != address(0) && address(aqua) != address(0), InvalidParties());
        ROUTER = router;
        AQUA = aqua;
        QUOTER = new MandateQuoter(router, IMandateRegistry(address(this)));
    }

    // ================================================================ modifiers

    modifier onlyPolicyIssuer(bytes32 policyId) {
        require(msg.sender == _policies[policyId].safe, NotIssuer(msg.sender));
        _;
    }

    modifier onlyStrategyIssuer(bytes32 strategyId) {
        require(msg.sender == _policies[_strategies[strategyId].policyId].safe, NotIssuer(msg.sender));
        _;
    }

    modifier onlyMarketMaker(bytes32 strategyId) {
        require(msg.sender == _strategies[strategyId].mm, NotMarketMaker(msg.sender));
        _;
    }

    // ================================================================ issuer: policies

    /// @inheritdoc IMandateModule
    function createPolicy(address base, address quote, PolicyConfig calldata config)
        external
        nonReentrant
        returns (bytes32 policyId)
    {
        address safe = msg.sender;
        require(ISafe(safe).isModuleEnabled(address(this)), ModuleNotEnabled(safe));
        require(base != address(0) && quote != address(0) && base != quote, InvalidParties());
        bytes32 existing = _activePolicyOf[safe][base];
        require(existing == bytes32(0), PolicyAlreadyActive(existing));
        _validatePolicy(config);

        policyId = keccak256(abi.encode(block.chainid, address(this), safe, "policy", policyCount[safe]++));
        Policy storage p = _policies[policyId];
        p.safe = safe;
        p.base = base;
        p.quote = quote;
        p.status = Status.Active;
        p.config = config;
        _policiesOf[safe].push(policyId);
        _activePolicyOf[safe][base] = policyId;

        emit PolicyCreated(policyId, safe, base, quote);
        emit PolicyUpdated(policyId, config);

        _approveAqua(safe, base);
        _approveAqua(safe, quote);
    }

    /// @inheritdoc IMandateModule
    function updatePolicy(bytes32 policyId, PolicyConfig calldata config) external onlyPolicyIssuer(policyId) {
        Policy storage p = _policies[policyId];
        require(p.status != Status.Revoked, IsRevoked());
        _validatePolicy(config);
        p.config = config;
        emit PolicyUpdated(policyId, config);
    }

    /// @inheritdoc IMandateModule
    function pausePolicy(bytes32 policyId) external onlyPolicyIssuer(policyId) {
        Policy storage p = _policies[policyId];
        require(p.status == Status.Active, NotActive());
        p.status = Status.Paused;
        emit PolicyPaused(policyId);
    }

    /// @inheritdoc IMandateModule
    function unpausePolicy(bytes32 policyId) external onlyPolicyIssuer(policyId) {
        Policy storage p = _policies[policyId];
        require(p.status == Status.Paused, NotPaused());
        p.status = Status.Active;
        emit PolicyUnpaused(policyId);
    }

    /// @inheritdoc IMandateModule
    /// @dev Status flips first, so the quoter refuses every fill even if docking fails.
    function revokePolicy(bytes32 policyId) external nonReentrant onlyPolicyIssuer(policyId) {
        Policy storage p = _policies[policyId];
        require(p.status != Status.Revoked, IsRevoked());
        p.status = Status.Revoked;
        delete _activePolicyOf[p.safe][p.base];
        emit PolicyRevoked(policyId);

        bytes32[] storage ids = _strategiesOf[policyId];
        for (uint256 i; i < ids.length; ++i) {
            if (_strategies[ids[i]].status != Status.Revoked) _revokeStrategy(ids[i]);
        }
    }

    // ================================================================ issuer: strategies

    /// @inheritdoc IMandateModule
    function addStrategy(
        bytes32 policyId,
        address mm,
        StrategyKind kind,
        StrategyBounds calldata bounds,
        StrategyParams calldata params
    )
        external
        nonReentrant
        onlyPolicyIssuer(policyId)
        returns (bytes32 strategyId)
    {
        Policy storage p = _policies[policyId];
        require(p.status == Status.Active, PolicyNotActive());
        require(mm != address(0) && mm != p.safe, InvalidParties());
        bytes32[] storage ids = _strategiesOf[policyId];
        require(ids.length < MAX_STRATEGIES_PER_POLICY, TooManyStrategies(MAX_STRATEGIES_PER_POLICY));
        require(_liveStrategiesOf[p.safe].length < MAX_LIVE_STRATEGIES_PER_SAFE, TooManyStrategies(MAX_LIVE_STRATEGIES_PER_SAFE));
        _validateStrategyBounds(kind, bounds);
        _validateParams(bounds, params);

        strategyId = keccak256(abi.encode(block.chainid, address(this), policyId, "strategy", ids.length));
        Strategy storage s = _strategies[strategyId];
        s.policyId = policyId;
        s.mm = mm;
        s.kind = kind;
        s.status = Status.Active;
        s.bounds = bounds;
        s.params = params;
        ids.push(strategyId);
        _liveStrategiesOf[p.safe].push(strategyId);

        emit StrategyAdded(strategyId, policyId, mm, kind);
        emit StrategyBoundsUpdated(strategyId, bounds);
        emit StrategyParamsUpdated(strategyId, params);
        _ship(strategyId, s, p);
    }

    /// @inheritdoc IMandateModule
    function updateStrategyBounds(bytes32 strategyId, StrategyBounds calldata bounds)
        external
        onlyStrategyIssuer(strategyId)
    {
        Strategy storage s = _strategies[strategyId];
        require(s.status != Status.Revoked, IsRevoked());
        require(bounds.mmFeeShareBps == s.bounds.mmFeeShareBps, FeeShareIsFixed(s.bounds.mmFeeShareBps, bounds.mmFeeShareBps));
        _validateStrategyBounds(s.kind, bounds);
        s.bounds = bounds;
        // Keep the live spread inside the new range; shipped amounts are re-checked on the next reship.
        // casting to 'uint16' is safe because the value is clamped between two uint16 bounds
        // forge-lint: disable-next-line(unsafe-typecast)
        s.params.spreadBps = uint16(Math.min(Math.max(s.params.spreadBps, bounds.spreadBpsMin), bounds.spreadBpsMax));
        emit StrategyBoundsUpdated(strategyId, bounds);
        emit StrategyParamsUpdated(strategyId, s.params);
    }

    /// @inheritdoc IMandateModule
    function unpauseStrategy(bytes32 strategyId) external onlyStrategyIssuer(strategyId) {
        Strategy storage s = _strategies[strategyId];
        require(s.status == Status.Paused, NotPaused());
        s.status = Status.Active;
        emit StrategyUnpaused(strategyId);
    }

    /// @inheritdoc IMandateModule
    function revokeStrategy(bytes32 strategyId) external nonReentrant onlyStrategyIssuer(strategyId) {
        require(_strategies[strategyId].status != Status.Revoked, IsRevoked());
        _revokeStrategy(strategyId);
    }

    // ================================================================ market maker

    /// @inheritdoc IMandateModule
    function reship(bytes32 strategyId, StrategyParams calldata params)
        external
        nonReentrant
        onlyMarketMaker(strategyId)
    {
        Strategy storage s = _strategies[strategyId];
        require(s.status != Status.Revoked, IsRevoked());
        Policy storage p = _policies[s.policyId];
        require(p.status != Status.Revoked, IsRevoked());
        _validateParams(s.bounds, params);

        _exec(p.safe, address(AQUA), _dockCalldata(s, p));
        emit StrategyDocked(strategyId, s.activeStrategyHash);

        s.params = params;
        emit StrategyParamsUpdated(strategyId, params);
        _ship(strategyId, s, p);
    }

    /// @inheritdoc IMandateModule
    function claimFees(bytes32 strategyId)
        external
        nonReentrant
        onlyMarketMaker(strategyId)
        returns (uint256 baseAmount, uint256 quoteAmount)
    {
        Strategy storage s = _strategies[strategyId];
        Policy storage p = _policies[s.policyId];
        (baseAmount, quoteAmount) = _claimable(strategyId, s);
        require(baseAmount > 0 || quoteAmount > 0, NothingToClaim());

        Claimed storage c = _claimed[strategyId];
        c.base += baseAmount;
        c.quote += quoteAmount;
        emit FeesClaimed(strategyId, s.mm, baseAmount, quoteAmount);

        if (baseAmount > 0) _transferFromSafe(p.safe, p.base, s.mm, baseAmount);
        if (quoteAmount > 0) _transferFromSafe(p.safe, p.quote, s.mm, quoteAmount);
    }

    // ================================================================ either party

    /// @inheritdoc IMandateModule
    function pauseStrategy(bytes32 strategyId) external {
        Strategy storage s = _strategies[strategyId];
        require(msg.sender == _policies[s.policyId].safe || msg.sender == s.mm, NotIssuerOrMarketMaker(msg.sender));
        require(s.status == Status.Active, NotActive());
        s.status = Status.Paused;
        emit StrategyPaused(strategyId, msg.sender);
    }

    // ================================================================ views

    /// @inheritdoc IMandateRegistry
    function getPolicy(bytes32 policyId) external view returns (Policy memory) {
        return _policies[policyId];
    }

    /// @inheritdoc IMandateRegistry
    function getStrategy(bytes32 strategyId) external view returns (Strategy memory) {
        return _strategies[strategyId];
    }

    /// @inheritdoc IMandateModule
    function policiesOf(address safe) external view returns (bytes32[] memory) {
        return _policiesOf[safe];
    }

    /// @inheritdoc IMandateModule
    function activePolicyOf(address safe, address base) external view returns (bytes32) {
        return _activePolicyOf[safe][base];
    }

    /// @inheritdoc IMandateModule
    function strategiesOf(bytes32 policyId) external view returns (bytes32[] memory) {
        return _strategiesOf[policyId];
    }

    /// @inheritdoc IMandateModule
    function liveStrategiesOf(address safe) external view returns (bytes32[] memory) {
        return _liveStrategiesOf[safe];
    }

    /// @inheritdoc IMandateModule
    function activeOrder(bytes32 strategyId) public view returns (ISwapVM.Order memory) {
        Strategy storage s = _strategies[strategyId];
        return MandateStrategy.order(_policies[s.policyId].safe, address(QUOTER), strategyId, strategyNonce[strategyId]);
    }

    /// @inheritdoc IMandateModule
    function claimable(bytes32 strategyId) external view returns (uint256 baseAmount, uint256 quoteAmount) {
        return _claimable(strategyId, _strategies[strategyId]);
    }

    /// @inheritdoc IMandateModule
    function claimed(bytes32 strategyId) external view returns (uint256 baseAmount, uint256 quoteAmount) {
        Claimed memory c = _claimed[strategyId];
        return (c.base, c.quote);
    }

    // ================================================================ validation

    function _validatePolicy(PolicyConfig calldata c) private pure {
        require(c.release.allotment > 0, InvalidPolicy("allotment"));
        require(c.release.releaseDuration > 0, InvalidPolicy("releaseDuration"));
        require(c.period.periodLength > 0, InvalidPolicy("periodLength"));
        require(c.period.grossSellCap > 0, InvalidPolicy("grossSellCap"));
        require(c.period.netSellCap > 0 && c.period.netSellCap <= c.period.grossSellCap, InvalidPolicy("netSellCap"));
        require(c.price.maxQuoteDeviationBps <= BPS, InvalidPolicy("maxQuoteDeviationBps"));
        require(c.price.maxImpactBps <= BPS, InvalidPolicy("maxImpactBps"));

        require(c.oracle.oracle != address(0), InvalidPolicy("oracle"));
        require(c.oracle.twapWindow > 0, InvalidPolicy("twapWindow"));
        require(c.oracle.shortWindow > 0 && c.oracle.shortWindow <= c.oracle.twapWindow, InvalidPolicy("shortWindow"));
        require(c.oracle.depthBandBps > 0 && c.oracle.depthBandBps < BPS, InvalidPolicy("depthBandBps"));
        require(c.oracle.defensiveMoveBps <= c.oracle.pauseMoveBps, InvalidPolicy("defensiveMoveBps"));
        require(c.oracle.defensiveVolatilityBps <= c.oracle.pauseVolatilityBps, InvalidPolicy("defensiveVolatilityBps"));
        require(c.oracle.minTrustedDepth <= c.oracle.defensiveDepth, InvalidPolicy("defensiveDepth"));

        _validateModeLimits(c.normal, "normal");
        _validateModeLimits(c.defensive, "defensive");
        // Defensive mode may never be looser than normal mode.
        require(c.defensive.maxFillBase <= c.normal.maxFillBase, InvalidPolicy("defensive.maxFillBase"));
        require(c.defensive.maxFillDepthBps <= c.normal.maxFillDepthBps, InvalidPolicy("defensive.maxFillDepthBps"));
        require(c.defensive.minSpreadBps >= c.normal.minSpreadBps, InvalidPolicy("defensive.minSpreadBps"));
        require(!c.defensive.buybacksAllowed || c.normal.buybacksAllowed, InvalidPolicy("defensive.buybacksAllowed"));
    }

    function _validateModeLimits(ModeLimits calldata m, string memory mode) private pure {
        require(m.maxFillBase > 0, InvalidPolicy(string.concat(mode, ".maxFillBase")));
        require(m.maxFillDepthBps > 0 && m.maxFillDepthBps <= BPS, InvalidPolicy(string.concat(mode, ".maxFillDepthBps")));
        require(m.minSpreadBps < BPS, InvalidPolicy(string.concat(mode, ".minSpreadBps")));
    }

    function _validateStrategyBounds(StrategyKind kind, StrategyBounds calldata b) private pure {
        require(b.spreadBpsMin <= b.spreadBpsMax && b.spreadBpsMax < BPS, InvalidStrategy("spreadBps"));
        require(b.maxShippedBase > 0 && b.maxShippedQuote > 0, InvalidStrategy("maxShipped"));
        require(b.mmFeeShareBps <= BPS, InvalidStrategy("mmFeeShareBps"));
        if (kind == StrategyKind.Buyback) {
            require(b.maxBuyPriceX36 > 0, InvalidStrategy("maxBuyPriceX36"));
        } else {
            require(b.maxBuyPriceX36 == 0, InvalidStrategy("maxBuyPriceX36"));
        }
    }

    function _validateParams(StrategyBounds memory b, StrategyParams calldata p) private pure {
        require(p.spreadBps >= b.spreadBpsMin && p.spreadBps <= b.spreadBpsMax, ParamsOutOfBounds("spreadBps"));
        require(p.shippedBase > 0 && p.shippedBase <= b.maxShippedBase, ParamsOutOfBounds("shippedBase"));
        require(p.shippedQuote > 0 && p.shippedQuote <= b.maxShippedQuote, ParamsOutOfBounds("shippedQuote"));
    }

    // ================================================================ Safe actions

    function _ship(bytes32 strategyId, Strategy storage s, Policy storage p) private {
        uint256 nonce = ++strategyNonce[strategyId];
        bytes memory order = abi.encode(MandateStrategy.order(p.safe, address(QUOTER), strategyId, nonce));
        (address[] memory tokens, uint256[] memory amounts) = _tokensAndAmounts(s, p);

        _exec(p.safe, address(AQUA), abi.encodeCall(IAqua.ship, (ROUTER, order, tokens, amounts)));
        s.activeStrategyHash = keccak256(order);
        emit StrategyShipped(strategyId, s.activeStrategyHash, nonce);

        _requireBacking(p.safe, p.base);
        _requireBacking(p.safe, p.quote);
    }

    /// @dev Status flips first so the quoter refuses every fill even if docking fails (e.g. module disabled).
    function _revokeStrategy(bytes32 strategyId) private {
        Strategy storage s = _strategies[strategyId];
        Policy storage p = _policies[s.policyId];
        s.status = Status.Revoked;
        _removeLive(p.safe, strategyId);

        bool docked;
        try ISafe(p.safe).execTransactionFromModuleReturnData(address(AQUA), 0, _dockCalldata(s, p), ISafe.Operation.Call)
        returns (bool success, bytes memory) {
            docked = success;
        } catch { }
        if (docked) emit StrategyDocked(strategyId, s.activeStrategyHash);
        emit StrategyRevoked(strategyId, docked);
    }

    /// @dev Aqua balances are virtual: the Safe's live strategies may not, together, claim more of `token` than it holds.
    function _requireBacking(address safe, address token) private view {
        bytes32[] storage live = _liveStrategiesOf[safe];
        uint256 committed;
        for (uint256 i; i < live.length; ++i) {
            (uint248 balance,) = AQUA.rawBalances(safe, ROUTER, _strategies[live[i]].activeStrategyHash, token);
            committed += balance;
        }
        uint256 held = IERC20(token).balanceOf(safe);
        require(committed <= held, InsufficientBacking(token, committed, held));
    }

    function _removeLive(address safe, bytes32 strategyId) private {
        bytes32[] storage live = _liveStrategiesOf[safe];
        for (uint256 i; i < live.length; ++i) {
            if (live[i] == strategyId) {
                live[i] = live[live.length - 1];
                live.pop();
                return;
            }
        }
    }

    function _dockCalldata(Strategy storage s, Policy storage p) private view returns (bytes memory) {
        (address[] memory tokens,) = _tokensAndAmounts(s, p);
        return abi.encodeCall(IAqua.dock, (ROUTER, s.activeStrategyHash, tokens));
    }

    function _tokensAndAmounts(Strategy storage s, Policy storage p)
        private
        view
        returns (address[] memory tokens, uint256[] memory amounts)
    {
        tokens = new address[](2);
        tokens[0] = p.base;
        tokens[1] = p.quote;
        amounts = new uint256[](2);
        amounts[0] = s.params.shippedBase;
        amounts[1] = s.params.shippedQuote;
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

    function _claimable(bytes32 strategyId, Strategy storage s) private view returns (uint256 baseAmount, uint256 quoteAmount) {
        if (s.status == Status.None) return (0, 0);
        (uint256 baseFees, uint256 quoteFees) = QUOTER.feesAccrued(strategyId);
        Claimed memory c = _claimed[strategyId];
        uint256 share = s.bounds.mmFeeShareBps;
        baseAmount = Math.mulDiv(baseFees, share, BPS) - c.base;
        quoteAmount = Math.mulDiv(quoteFees, share, BPS) - c.quote;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";

import { UniswapV4MarketOracle } from "../../src/anchor/UniswapV4MarketOracle.sol";
import { IMandateQuoter } from "../../src/interfaces/IMandateQuoter.sol";
import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";
import { Policy, RiskMode, RiskReason, Strategy } from "../../src/libraries/MandateTypes.sol";
import { MandateModule } from "../../src/module/MandateModule.sol";

/// @notice Fixed-width snapshot of one strategy and its policy for the replay exporter. Read at the attempt's
///         receipt block. Field order is the exporter's schema (replay/codec.ts SNAPSHOT_FIELDS).
contract DemoState {
    using StateLibrary for IPoolManager;

    uint256 public constant FIELDS = 22;

    MandateModule public immutable MODULE;
    UniswapV4MarketOracle public immutable ORACLE;
    UniswapV4MarketOracle public immutable TRADITIONAL_ORACLE;
    address public immutable TRADITIONAL_MM;

    constructor(
        MandateModule module,
        UniswapV4MarketOracle oracle,
        UniswapV4MarketOracle traditionalOracle,
        address traditionalMm
    ) {
        MODULE = module;
        ORACLE = oracle;
        TRADITIONAL_ORACLE = traditionalOracle;
        TRADITIONAL_MM = traditionalMm;
    }

    function snapshot(bytes32 strategyId) external view returns (uint256[FIELDS] memory s) {
        Strategy memory st = MODULE.getStrategy(strategyId);
        Policy memory p = MODULE.getPolicy(st.policyId);
        IMandateQuoter quoter = IMandateQuoter(address(MODULE.QUOTER()));
        s[0] = IERC20(p.base).balanceOf(p.safe);
        s[1] = IERC20(p.quote).balanceOf(p.safe);
        IMandateQuoter.PolicyCounters memory c = quoter.policyCounters(st.policyId);
        s[2] = c.grossSold;
        s[3] = c.netSold;
        s[4] = c.totalNetSold;
        s[5] = c.quoteSpent;
        s[6] = c.released;
        s[7] = IERC20(p.base).balanceOf(TRADITIONAL_MM);
        s[8] = IERC20(p.quote).balanceOf(TRADITIONAL_MM);
        s[9] = _spot(ORACLE);
        (RiskMode mode, RiskReason reason, IMarketOracle.Health memory h) = quoter.riskMode(st.policyId);
        s[10] = h.twapX36;
        s[11] = h.shortTwapX36;
        s[12] = h.trustedDepthBase;
        s[13] = uint256(mode);
        s[14] = uint256(reason);
        (s[15], s[16]) = MODULE.claimed(strategyId);
        s[17] = st.params.spreadBps;
        s[18] = MODULE.strategyNonce(strategyId);
        s[19] = uint256(st.status);
        s[20] = uint256(p.status);
        s[21] = _spot(TRADITIONAL_ORACLE);
    }

    /// @dev Spot from slot0, available even before the oracle has TWAP history.
    function _spot(UniswapV4MarketOracle o) private view returns (uint256) {
        (, int24 tick,,) = o.POOL_MANAGER().getSlot0(o.POOL_ID());
        return o.priceAtTick(tick);
    }
}

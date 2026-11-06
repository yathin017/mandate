// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { MandateModule } from "../../src/module/MandateModule.sol";
import { Mandate } from "../../src/libraries/MandateTypes.sol";
import { UniswapV4TwapAnchor } from "../../src/anchor/UniswapV4TwapAnchor.sol";

/// @notice Fixed-width snapshot for the replay exporter. Read at the attempt's receipt block.
contract DemoState {
    MandateModule public immutable MODULE;
    UniswapV4TwapAnchor public immutable ANCHOR;
    UniswapV4TwapAnchor public immutable TRADITIONAL_ANCHOR;
    address public immutable TRADITIONAL_MM;

    constructor(
        MandateModule module,
        UniswapV4TwapAnchor anchor,
        UniswapV4TwapAnchor traditionalAnchor,
        address traditionalMm
    ) {
        MODULE = module;
        ANCHOR = anchor;
        TRADITIONAL_ANCHOR = traditionalAnchor;
        TRADITIONAL_MM = traditionalMm;
    }

    function snapshot(bytes32 id) external view returns (uint256[17] memory s) {
        Mandate memory m = MODULE.getMandate(id);
        s[0] = IERC20(m.base).balanceOf(m.safe);
        s[1] = IERC20(m.quote).balanceOf(m.safe);
        (, s[2], s[3]) = MODULE.QUOTER().epochState(id);
        s[4] = IERC20(m.base).balanceOf(TRADITIONAL_MM);
        s[5] = IERC20(m.quote).balanceOf(TRADITIONAL_MM);
        (s[6], s[7],) = ANCHOR.snapshot(m.bounds.twapWindow);
        (s[8], s[9]) = MODULE.claimed(id);
        s[10] = MODULE.QUOTER().released(id);
        s[11] = MODULE.QUOTER().remainingThisEpoch(id);
        (s[12],,) = TRADITIONAL_ANCHOR.snapshot(m.bounds.twapWindow);
        s[13] = m.params.spreadBps;
        s[14] = m.params.epochCap;
        s[15] = MODULE.strategyNonce(id);
        s[16] = uint256(m.status);
    }
}

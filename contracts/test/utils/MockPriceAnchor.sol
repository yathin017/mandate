// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IPriceAnchor} from "../../src/interfaces/IPriceAnchor.sol";

/// @notice Fixed-price anchor for tests until the Uniswap v4 TWAP adapter (Segment 3).
contract MockPriceAnchor is IPriceAnchor {
    uint256 public priceX36;
    bool public broken;

    error AnchorUnavailable();

    function setPrice(uint256 priceX36_) external {
        priceX36 = priceX36_;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function consult(address, address, uint32) external view returns (uint256) {
        require(!broken, AnchorUnavailable());
        return priceX36;
    }
}

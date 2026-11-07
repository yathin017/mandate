// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { IMarketOracle } from "../../src/interfaces/IMarketOracle.sol";

/// @notice Settable market readings for tests. Pair and windows are ignored; the readings are whatever the test sets.
contract MockMarketOracle is IMarketOracle {
    Health private _health;

    /// @dev A healthy, flat market at `priceX36` with `depth` base of trusted depth and an old pool.
    function setFlat(uint256 priceX36, uint256 depth) external {
        _health = Health({ priced: true, spotX36: priceX36, twapX36: priceX36, shortTwapX36: priceX36, trustedDepthBase: depth, poolAge: type(uint32).max });
    }

    function set(Health calldata h) external {
        _health = h;
    }

    function setSpot(uint256 spotX36) external {
        _health.spotX36 = spotX36;
    }

    function setShortTwap(uint256 shortTwapX36) external {
        _health.shortTwapX36 = shortTwapX36;
    }

    function setDepth(uint256 depth) external {
        _health.trustedDepthBase = depth;
    }

    function setPriced(bool priced) external {
        _health.priced = priced;
    }

    function setPoolAge(uint32 age) external {
        _health.poolAge = age;
    }

    function health(address, address, uint32, uint32, uint16) external view returns (Health memory) {
        return _health;
    }
}

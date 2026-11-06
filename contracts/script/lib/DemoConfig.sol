// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import { MandateBounds, MandateParams } from "../../src/libraries/MandateTypes.sol";

/// @notice Shared, deliberately SYNTHETIC inputs for local-fork deployment and Acts 1–3.
library DemoConfig {
    using stdJson for string;
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    uint256 internal constant PRICE = 4e23;
    uint32 internal constant WINDOW = 30 minutes;
    uint256 internal constant ALLOTMENT = 10_000_000e18;
    uint256 internal constant BURST_ALLOTMENT = 134_100_000e18;
    uint256 internal constant CAP = 50_000e18;

    function guard() internal view {
        require(block.chainid == 31_337, "Demo: local chain 31337 only");
    }

    function keys() internal pure returns (uint256[] memory k) {
        k = new uint256[](2);
        uint256 a = VM.deriveKey(MNEMONIC, 0);
        uint256 b = VM.deriveKey(MNEMONIC, 1);
        (k[0], k[1]) = VM.addr(a) < VM.addr(b) ? (a, b) : (b, a);
    }

    function deployer() internal pure returns (address) {
        return VM.addr(VM.deriveKey(MNEMONIC, 0));
    }

    function path() internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/../deployments/1.json");
    }

    function manifest() internal view returns (string memory json) {
        json = VM.readFile(path());
        require(json.readUint(".chainId") == block.chainid, "Demo: manifest chain mismatch");
        require(
            keccak256(bytes(json.readString(".environment"))) == keccak256("local-mainnet-fork"),
            "Demo: not a fork manifest"
        );
    }

    function pool(address base, address quote, address hook, bool traditional) internal pure returns (PoolKey memory) {
        (address a, address b) = base < quote ? (base, quote) : (quote, base);
        return PoolKey({
            currency0: Currency.wrap(a),
            currency1: Currency.wrap(b),
            fee: traditional ? 500 : 3000,
            tickSpacing: traditional ? int24(10) : int24(60),
            hooks: IHooks(hook)
        });
    }

    function sqrtPrice(address base, address quote, uint256 price) internal pure returns (uint160) {
        uint256 ratio = base < quote ? Math.mulDiv(price, 1 << 192, 1e36) : Math.mulDiv(1e36, 1 << 192, price);
        // A square root of uint256 fits uint128, hence uint160.
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(Math.sqrt(ratio));
    }

    function bounds(address anchor, bool burst) internal view returns (MandateBounds memory) {
        return MandateBounds({
            allotment: burst ? BURST_ALLOTMENT : ALLOTMENT,
            releaseStart: uint64(block.timestamp - 20 days),
            releaseDuration: 180 days,
            epochLength: 1 days,
            maxEpochCap: burst ? 1_341_000e18 : CAP,
            maxShippedQuote: burst ? 53_640_000e6 : 4_000_000e6,
            floorPriceX36: 3e23,
            maxAnchorDeviationBps: 300,
            twapWindow: WINDOW,
            spreadBpsMin: 10,
            spreadBpsMax: 200,
            mmFeeShareBps: 5000,
            anchor: anchor,
            quoter: address(0)
        });
    }

    function params(bool burst) internal pure returns (MandateParams memory) {
        return MandateParams({
            spreadBps: 80,
            epochCap: burst ? 1_341_000e18 : CAP,
            shippedBase: burst ? BURST_ALLOTMENT : ALLOTMENT,
            shippedQuote: burst ? 53_640_000e6 : 4_000_000e6
        });
    }
}

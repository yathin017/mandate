// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";

import { MandateBounds, MandateParams } from "../../src/libraries/MandateTypes.sol";

/// @notice Settings for the live Base mainnet demo (chain 8453). Tokens are worthless owner-mintable mocks with
///         clearly-test names; keys are throwaway keys read from the gitignored .env, never from source.
library LiveConfig {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant CHAIN_ID = 8453;
    /// @dev 0.40 mUSD per mLAUNCH in `quoteRaw * 1e36 / baseRaw` units.
    uint256 internal constant PRICE = 4e23;
    uint256 internal constant ALLOTMENT = 1_000_000e18;
    uint256 internal constant BUYBACK = 400_000e6;
    uint256 internal constant DAILY_CAP = 50_000e18;
    /// @dev Gas top-up for the second Safe owner and the market maker (enough for dozens of Base transactions).
    uint256 internal constant GAS_TOPUP = 0.0002 ether;

    function guard() internal view {
        require(block.chainid == CHAIN_ID, "Live: Base mainnet (8453) only");
    }

    function deployerKey() internal view returns (uint256) {
        return VM.envUint("BASE_DEPLOYER_PRIVATE_KEY");
    }

    function owner2Key() internal view returns (uint256) {
        return VM.envUint("BASE_OWNER2_PRIVATE_KEY");
    }

    function mmKey() internal view returns (uint256) {
        return VM.envUint("BASE_MM_PRIVATE_KEY");
    }

    /// @dev Both Safe owner keys, sorted by owner address as Safe signature checks require.
    function sortedOwnerKeys() internal view returns (uint256[] memory keys) {
        keys = new uint256[](2);
        (uint256 a, uint256 b) = (deployerKey(), owner2Key());
        (keys[0], keys[1]) = VM.addr(a) < VM.addr(b) ? (a, b) : (b, a);
    }

    function path() internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/../deployments/8453.json");
    }

    function manifest() internal view returns (string memory json) {
        json = VM.readFile(path());
        require(json.readUint(".chainId") == CHAIN_ID, "Live: manifest chain mismatch");
    }

    /// @dev Mirrors the fork demo's terms (DemoConfig), scaled to a 1M allotment. Release began 20 days ago so some
    ///      inventory is sellable immediately.
    function bounds(address anchor) internal view returns (MandateBounds memory) {
        return MandateBounds({
            allotment: ALLOTMENT,
            releaseStart: uint64(block.timestamp - 20 days),
            releaseDuration: 180 days,
            epochLength: 1 days,
            maxEpochCap: DAILY_CAP,
            maxShippedQuote: BUYBACK,
            floorPriceX36: 3e23,
            maxAnchorDeviationBps: 300,
            twapWindow: 30 minutes,
            spreadBpsMin: 10,
            spreadBpsMax: 200,
            mmFeeShareBps: 5000,
            anchor: anchor,
            quoter: address(0)
        });
    }

    function params() internal pure returns (MandateParams memory) {
        return MandateParams({ spreadBps: 80, epochCap: DAILY_CAP, shippedBase: ALLOTMENT, shippedQuote: BUYBACK });
    }
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";

/// @notice Settings for the live Base mainnet demo (chain 8453). Tokens are worthless owner-mintable mocks with
///         clearly-test names; the deployer key is a throwaway key read from the gitignored .env, never from source.
///         Treasury policies and strategies are not configured here: their values are the issuer's, set in the app.
library LiveConfig {
    using stdJson for string;

    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant CHAIN_ID = 8453;
    /// @dev Starting pool price of the demo pair: 0.40 mUSD per mLAUNCH in `quoteRaw * 1e36 / baseRaw` units.
    uint256 internal constant PRICE = 4e23;
    /// @dev Demo inventory minted into the issuer Safe (mock tokens, no value).
    uint256 internal constant SAFE_BASE = 1_000_000e18;
    uint256 internal constant SAFE_QUOTE = 400_000e6;
    /// @dev Full-range liquidity of the demo pool: ~9.5M mLAUNCH / ~3.8M mUSD at 0.40.
    int256 internal constant POOL_LIQUIDITY = 6e18;
    /// @dev Liquidity added within this many seconds is not trusted depth yet (hook constructor argument).
    uint32 internal constant SETTLE_SECONDS = 10 minutes;

    function guard() internal view {
        require(block.chainid == CHAIN_ID, "Live: Base mainnet (8453) only");
    }

    function deployerKey() internal view returns (uint256) {
        return VM.envUint("BASE_DEPLOYER_PRIVATE_KEY");
    }

    /// @dev Optional: only RotateRoles signs as Owner 2, and only when this key is in .env.
    function owner2Key() internal view returns (uint256) {
        return VM.envUint("BASE_OWNER2_PRIVATE_KEY");
    }

    /// @dev Optional: only LiveFills acts as the market maker, and only when this key is in .env.
    function mmKey() internal view returns (uint256) {
        return VM.envUint("BASE_MM_PRIVATE_KEY");
    }

    /// @notice Safe Owner 2: BASE_OWNER2_ADDRESS, else the archived v1 manifest's (the current testing wallet).
    function owner2() internal view returns (address) {
        return _role("BASE_OWNER2_ADDRESS", ".owner2");
    }

    /// @notice The demo market maker: BASE_MM_ADDRESS, else the archived v1 manifest's.
    function marketMaker() internal view returns (address) {
        return _role("BASE_MM_ADDRESS", ".mm");
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

    function _role(string memory env, string memory key) private view returns (address) {
        address fromEnv = VM.envOr(env, address(0));
        if (fromEnv != address(0)) return fromEnv;
        string memory archived = VM.readFile(string.concat(VM.projectRoot(), "/../deployments/archive/8453-v1.json"));
        return archived.readAddress(key);
    }
}

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
    /// @notice Safe Owner 2 of the Base demo Safe. Fixed by the project owner; scripts never replace it.
    address internal constant OWNER2 = 0x6a4fb4561051dD5B25619ab997152892008C7bF6;
    /// @notice The Base demo market maker. Fixed by the project owner; scripts never replace it.
    address internal constant MARKET_MAKER = 0xbDafcA30260a4a5550cAD1F11928b26f1B063126;
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

    /// @dev Optional: only LiveFills acts as the market maker, and only when this key is in .env.
    function mmKey() internal view returns (uint256) {
        return VM.envUint("BASE_MM_PRIVATE_KEY");
    }

    function path() internal view returns (string memory) {
        return string.concat(VM.projectRoot(), "/../deployments/8453.json");
    }

    function manifest() internal view returns (string memory json) {
        json = VM.readFile(path());
        require(json.readUint(".chainId") == CHAIN_ID, "Live: manifest chain mismatch");
    }
}

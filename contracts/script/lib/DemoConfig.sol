// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Vm } from "forge-std/Vm.sol";
import { stdJson } from "forge-std/StdJson.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";
import {
    ModeLimits,
    OracleRules,
    PeriodLimits,
    PolicyConfig,
    PriceRules,
    ReleaseLimits,
    StrategyBounds,
    StrategyParams
} from "../../src/libraries/MandateTypes.sol";

/// @notice Shared, deliberately SYNTHETIC inputs for local-fork deployment and Acts 1–3.
library DemoConfig {
    using stdJson for string;
    Vm private constant VM = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    string internal constant MNEMONIC = "test test test test test test test test test test test junk";
    uint256 internal constant PRICE = 4e23;
    uint32 internal constant WINDOW = 30 minutes;
    uint32 internal constant SHORT_WINDOW = 5 minutes;
    /// @dev Liquidity added within this many seconds is not trusted depth yet (hook constructor argument).
    uint32 internal constant SETTLE_SECONDS = 10 minutes;
    uint256 internal constant ALLOTMENT = 10_000_000e18;
    uint256 internal constant QUOTE = 4_000_000e6;
    uint256 internal constant BURST_ALLOTMENT = 134_100_000e18;
    uint256 internal constant BURST_QUOTE = 53_640_000e6;
    uint256 internal constant NET_CAP = 50_000e18;
    uint256 internal constant BURST_NET_CAP = 1_341_000e18;
    /// @dev Full-range liquidity of the anchor pool (~100M LAUNCH / 40M sUSDC at 0.40) and of the thin pool the
    ///      traditional market maker dumps into (~1M / 400k).
    int256 internal constant ANCHOR_LIQUIDITY = 6e19;
    int256 internal constant TRADITIONAL_LIQUIDITY = 6e17;

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

    /// @notice SYNTHETIC policy for one demo Safe. `burst` is Act 2's larger treasury. On the platform every value
    ///         here is the issuer's choice; these only make the acts readable.
    function policy(address oracle, bool burst) internal view returns (PolicyConfig memory) {
        return PolicyConfig({
            release: ReleaseLimits({
                allotment: burst ? BURST_ALLOTMENT : ALLOTMENT,
                releaseStart: uint64(block.timestamp - 20 days),
                releaseDuration: 180 days
            }),
            period: PeriodLimits({
                periodLength: 1 days,
                grossSellCap: 2 * (burst ? BURST_NET_CAP : NET_CAP),
                netSellCap: burst ? BURST_NET_CAP : NET_CAP,
                quoteSpendCap: burst ? 1_000_000e6 : 100_000e6
            }),
            price: PriceRules({ floorPriceX36: 3e23, maxQuoteDeviationBps: 300, maxImpactBps: 300 }),
            oracle: OracleRules({
                oracle: oracle,
                twapWindow: WINDOW,
                shortWindow: SHORT_WINDOW,
                depthBandBps: 500,
                minPoolAge: 1 hours,
                minTrustedDepth: 100_000e18,
                defensiveMoveBps: 200,
                pauseMoveBps: 1000,
                defensiveVolatilityBps: 300,
                pauseVolatilityBps: 1500,
                defensiveDepth: 500_000e18
            }),
            normal: ModeLimits({ maxFillBase: 1_000_000e18, maxFillDepthBps: 5000, minSpreadBps: 0, buybacksAllowed: true }),
            defensive: ModeLimits({
                maxFillBase: 100_000e18, maxFillDepthBps: 2000, minSpreadBps: 150, buybacksAllowed: false
            })
        });
    }

    function strategyBounds(bool burst) internal pure returns (StrategyBounds memory) {
        return StrategyBounds({
            spreadBpsMin: 10,
            spreadBpsMax: 200,
            maxShippedBase: burst ? BURST_ALLOTMENT : ALLOTMENT,
            maxShippedQuote: burst ? BURST_QUOTE : QUOTE,
            mmFeeShareBps: 5000,
            maxBuyPriceX36: 0
        });
    }

    function params(bool burst) internal pure returns (StrategyParams memory) {
        return StrategyParams({
            spreadBps: 80,
            shippedBase: burst ? BURST_ALLOTMENT : ALLOTMENT,
            shippedQuote: burst ? BURST_QUOTE : QUOTE
        });
    }
}

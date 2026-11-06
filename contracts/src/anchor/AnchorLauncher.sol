// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IHooks } from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import { IPoolManager } from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import { StateLibrary } from "@uniswap/v4-core/src/libraries/StateLibrary.sol";
import { TickMath } from "@uniswap/v4-core/src/libraries/TickMath.sol";
import { Currency } from "@uniswap/v4-core/src/types/Currency.sol";
import { PoolId, PoolIdLibrary } from "@uniswap/v4-core/src/types/PoolId.sol";
import { PoolKey } from "@uniswap/v4-core/src/types/PoolKey.sol";

import { MandateOracleHook } from "../hook/MandateOracleHook.sol";
import { UniswapV4TwapAnchor } from "./UniswapV4TwapAnchor.sol";

/// @title AnchorLauncher
/// @notice Self-serve setup of a price anchor for any ERC20 pair: creates the Uniswap v4 pool with the
///         MandateOracleHook (if it does not exist yet), grows its observation buffer so a swap cannot wipe the TWAP
///         history, and deploys a UniswapV4TwapAnchor for the (base, quote) orientation at a predictable address.
///
/// @dev Permissionless and immutable: no owner, no funds held. Liquidity is not added here; the pool is a normal
///      v4 pool that LPs fund with Uniswap's own tools. An anchor is only as strong as its pool's liquidity, so
///      integrators must show it to issuers. If someone else created the pool first, its existing price is kept
///      (reported by `poolCreated = false`); the TWAP then reflects whatever trades in that pool.
///      Quotes become available once the pool has one TWAP window of history (30 minutes for Mandate's default).
contract AnchorLauncher {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// @notice Pool parameters shared by every anchor pool this launcher creates.
    uint24 public constant FEE = 3000;
    int24 public constant TICK_SPACING = 60;
    /// @dev >= blocks per TWAP window with margin, so a burst of swaps cannot erase the window (NOTES §8).
    uint16 public constant OBSERVATION_CARDINALITY = 300;
    /// @dev Spot-vs-TWAP circuit breaker of every anchor deployed here.
    uint16 public constant MAX_SPOT_DEVIATION_BPS = 200;

    IPoolManager public immutable POOL_MANAGER;
    MandateOracleHook public immutable HOOK;

    /// @notice Anchor deployed for a (base, quote) orientation, or zero.
    mapping(address base => mapping(address quote => address anchor)) public anchorOf;

    event AnchorLaunched(
        PoolId indexed poolId,
        address indexed base,
        address indexed quote,
        address anchor,
        bool poolCreated,
        uint160 sqrtPriceX96
    );

    error HookPoolManagerMismatch();
    error InvalidPair(address base, address quote);
    error NotAToken(address token);
    error PriceOutOfRange(uint256 priceX36);

    constructor(IPoolManager poolManager, MandateOracleHook hook) {
        require(address(hook.poolManager()) == address(poolManager), HookPoolManagerMismatch());
        POOL_MANAGER = poolManager;
        HOOK = hook;
    }

    /// @notice Returns the anchor for `base` priced in `quote`, creating the pool and anchor if needed.
    /// @param initialPriceX36 Starting price (`quoteRaw * 1e36 / baseRaw`) used only if the pool does not exist yet.
    function launch(
        address base,
        address quote,
        uint256 initialPriceX36
    )
        external
        returns (UniswapV4TwapAnchor anchor, PoolId poolId, bool poolCreated)
    {
        require(base != quote && base != address(0) && quote != address(0), InvalidPair(base, quote));
        _requireToken(base);
        _requireToken(quote);

        PoolKey memory key = poolKeyFor(base, quote);
        poolId = key.toId();
        address existing = anchorOf[base][quote];
        if (existing != address(0)) return (UniswapV4TwapAnchor(existing), poolId, false);

        (uint160 sqrtPriceX96,,,) = POOL_MANAGER.getSlot0(poolId);
        if (sqrtPriceX96 == 0) {
            sqrtPriceX96 = sqrtPriceX96For(base, quote, initialPriceX36);
            POOL_MANAGER.initialize(key, sqrtPriceX96);
            poolCreated = true;
        }
        // Idempotent: the hook only ever grows the buffer.
        HOOK.increaseObservationCardinalityNext(OBSERVATION_CARDINALITY, poolId);

        anchor =
            new UniswapV4TwapAnchor{ salt: _salt(base, quote) }(POOL_MANAGER, key, base, quote, MAX_SPOT_DEVIATION_BPS);
        anchorOf[base][quote] = address(anchor);
        emit AnchorLaunched(poolId, base, quote, address(anchor), poolCreated, sqrtPriceX96);
    }

    /// @notice The anchor pool key for a pair (currencies sorted, launcher fee/spacing, Mandate hook).
    function poolKeyFor(address base, address quote) public view returns (PoolKey memory) {
        (address c0, address c1) = base < quote ? (base, quote) : (quote, base);
        return PoolKey({
            currency0: Currency.wrap(c0),
            currency1: Currency.wrap(c1),
            fee: FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(address(HOOK))
        });
    }

    /// @notice Address `launch` deploys (or deployed) the anchor for this orientation to.
    function predictAnchor(address base, address quote) external view returns (address) {
        bytes memory initCode = abi.encodePacked(
            type(UniswapV4TwapAnchor).creationCode,
            abi.encode(POOL_MANAGER, poolKeyFor(base, quote), base, quote, MAX_SPOT_DEVIATION_BPS)
        );
        bytes32 digest =
            keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(base, quote), keccak256(initCode)));
        return address(uint160(uint256(digest)));
    }

    /// @notice v4 sqrt price (currency1 per currency0, Q96) for a price of `base` in `quote` (X36 units).
    function sqrtPriceX96For(address base, address quote, uint256 priceX36) public pure returns (uint160) {
        require(priceX36 > 0, PriceOutOfRange(priceX36));
        uint256 ratioX192 = base < quote
            ? Math.mulDiv(priceX36, 1 << 192, 1e36)  // base is currency0: price = currency1 per currency0
            : Math.mulDiv(1e36, 1 << 192, priceX36); // base is currency1: invert
        uint256 sqrtPrice = Math.sqrt(ratioX192);
        require(sqrtPrice >= TickMath.MIN_SQRT_PRICE && sqrtPrice < TickMath.MAX_SQRT_PRICE, PriceOutOfRange(priceX36));
        // casting to 'uint160' is safe because it was bounded by MAX_SQRT_PRICE (< 2^160) above
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint160(sqrtPrice);
    }

    /// @dev Code alone is not enough (EIP-7702 delegated accounts have code): require an ERC20 `totalSupply()`.
    function _requireToken(address token) private view {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("totalSupply()"));
        require(token.code.length > 0 && ok && data.length == 32, NotAToken(token));
    }

    function _salt(address base, address quote) private pure returns (bytes32) {
        return keccak256(abi.encode(base, quote));
    }
}

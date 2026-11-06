import { getChainConfig } from "@mandate/chains";
import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, getAddress, maxUint256, maxUint48, parseAbi, size, type Address, type Hex } from "viem";

import { erc20Abi } from "./abis.ts";
import type { PoolKey } from "./onboarding.ts";
import type { PreparedCall } from "./transactions.ts";

/**
 * Full-range liquidity for an anchor pool, added by the issuer Safe through the canonical Uniswap v4 PositionManager.
 * The position NFT is minted to the Safe, so its owners can later remove the liquidity or collect pool fees.
 *
 * Everything happens in one Safe transaction: a batch run by Safe's canonical MultiSendCallOnly (the only contract
 * this app lets a Safe delegatecall). It approves Permit2 for exactly the maximum amounts, lets the PositionManager
 * pull through Permit2, mints, and resets the token approvals to zero.
 */

// ---------------------------------------------------------------- Uniswap math (ported from v4-core / v4-periphery)

const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;

/** TickMath.getSqrtPriceAtTick, constant for constant from the pinned v4-core source. */
export function sqrtPriceAtTick(tick: number): bigint {
  const abs = BigInt(Math.abs(tick));
  if (abs > BigInt(MAX_TICK)) throw new Error(`tick ${tick} out of range`);
  let price = abs & 0x1n ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  const steps: [bigint, bigint][] = [
    [0x2n, 0xfff97272373d413259a46990580e213an], [0x4n, 0xfff2e50f5f656932ef12357cf3c7fdccn],
    [0x8n, 0xffe5caca7e10e4e61c3624eaa0941cd0n], [0x10n, 0xffcb9843d60f6159c9db58835c926644n],
    [0x20n, 0xff973b41fa98c081472e6896dfb254c0n], [0x40n, 0xff2ea16466c96a3843ec78b326b52861n],
    [0x80n, 0xfe5dee046a99a2a811c461f1969c3053n], [0x100n, 0xfcbe86c7900a88aedcffc83b479aa3a4n],
    [0x200n, 0xf987a7253ac413176f2b074cf7815e54n], [0x400n, 0xf3392b0822b70005940c7a398e4b70f3n],
    [0x800n, 0xe7159475a2c29b7443b29c7fa6e889d9n], [0x1000n, 0xd097f3bdfd2022b8845ad8f792aa5825n],
    [0x2000n, 0xa9f746462d870fdf8a65dc1f90e061e5n], [0x4000n, 0x70d869a156d2a1b890bb3df62baf32f7n],
    [0x8000n, 0x31be135f97d08fd981231505542fcfa6n], [0x10000n, 0x9aa508b5b7a84e1c677de54f3e99bc9n],
    [0x20000n, 0x5d6af8dedb81196699c329225ee604n], [0x40000n, 0x2216e584f5fa1ea926041bedfe98n],
    [0x80000n, 0x48a170391f7dc42444e8fa2n],
  ];
  for (const [bit, factor] of steps) if (abs & bit) price = (price * factor) >> 128n;
  if (tick > 0) price = maxUint256 / price;
  return (price + (1n << 32n) - 1n) >> 32n;
}

/** Widest ticks usable at a tick spacing (TickMath.minUsableTick / maxUsableTick). */
export function fullRangeTicks(tickSpacing: number): { tickLower: number; tickUpper: number } {
  const upper = Math.trunc(MAX_TICK / tickSpacing) * tickSpacing;
  return { tickLower: -upper, tickUpper: upper };
}

const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

/** LiquidityAmounts.getLiquidityForAmount0 / getLiquidityForAmount1 (rounding down). */
function liquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
  return (amount0 * ((sqrtA * sqrtB) / Q96)) / (sqrtB - sqrtA);
}
function liquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

/** SqrtPriceMath.getAmount0Delta / getAmount1Delta, rounded up (what the pool will take). */
function amount0ForLiquidity(sqrtP: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  return mulDivUp(mulDivUp(liquidity << 96n, sqrtB - sqrtP, sqrtB), 1n, sqrtP);
}
function amount1ForLiquidity(sqrtA: bigint, sqrtP: bigint, liquidity: bigint): bigint {
  return mulDivUp(liquidity, sqrtP - sqrtA, Q96);
}

export interface LiquidityPlan {
  readonly poolKey: PoolKey;
  readonly tickLower: number;
  readonly tickUpper: number;
  readonly liquidity: bigint;
  /** What the pool takes at the current price, per currency (currency0/currency1 order). */
  readonly amount0: bigint;
  readonly amount1: bigint;
  /** Caps signed into the transaction: the amounts plus slippage. A larger price move makes the mint revert. */
  readonly amount0Max: bigint;
  readonly amount1Max: bigint;
}

/**
 * Plans a full-range position from an amount of the base token at the pool's current price: the liquidity that
 * amount supports, the quote it needs alongside, and slippage caps (default 1%).
 */
export function planFullRangeLiquidity(input: {
  poolKey: PoolKey;
  sqrtPriceX96: bigint;
  base: Address;
  baseAmount: bigint;
  slippageBps?: number;
}): LiquidityPlan {
  const { poolKey, sqrtPriceX96: sqrtP, baseAmount } = input;
  if (baseAmount <= 0n) throw new Error("Amount must be positive");
  const { tickLower, tickUpper } = fullRangeTicks(poolKey.tickSpacing);
  const sqrtA = sqrtPriceAtTick(tickLower);
  const sqrtB = sqrtPriceAtTick(tickUpper);
  if (sqrtP <= sqrtA || sqrtP >= sqrtB) throw new Error("Pool price is outside the full range");
  const baseIs0 = getAddress(input.base) === getAddress(poolKey.currency0);
  const liquidity = baseIs0 ? liquidityForAmount0(sqrtP, sqrtB, baseAmount) : liquidityForAmount1(sqrtA, sqrtP, baseAmount);
  if (liquidity === 0n) throw new Error("Amount too small for any liquidity");
  const amount0 = amount0ForLiquidity(sqrtP, sqrtB, liquidity);
  const amount1 = amount1ForLiquidity(sqrtA, sqrtP, liquidity);
  const slip = BigInt(input.slippageBps ?? 100);
  const withSlippage = (a: bigint) => a + mulDivUp(a, slip, 10_000n) + 1n;
  return { poolKey, tickLower, tickUpper, liquidity, amount0, amount1, amount0Max: withSlippage(amount0), amount1Max: withSlippage(amount1) };
}

// ---------------------------------------------------------------- the Safe's batched transaction

const permit2Abi = parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]);
const positionManagerAbi = parseAbi(["function modifyLiquidities(bytes unlockData, uint256 deadline) payable"]);
const multiSendAbi = parseAbi(["function multiSend(bytes transactions) payable"]);
/** v4-periphery Actions: MINT_POSITION then SETTLE_PAIR. */
const MINT_POSITION = 0x02;
const SETTLE_PAIR = 0x0d;
const POOL_KEY = { type: "tuple", components: [
  { name: "currency0", type: "address" }, { name: "currency1", type: "address" }, { name: "fee", type: "uint24" },
  { name: "tickSpacing", type: "int24" }, { name: "hooks", type: "address" },
] } as const;

/** One MultiSend entry: operation (0 = CALL only), target, value 0, data. */
function multiSendEntry(to: Address, data: Hex): Hex {
  return encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [0, to, 0n, BigInt(size(data)), data]);
}

/**
 * The Safe's single transaction for `plan`: a delegatecall to MultiSendCallOnly whose CALLs approve Permit2, set
 * the PositionManager's Permit2 allowances, mint the position to the Safe, and reset the token approvals. Execute it
 * as a Safe transaction with operation 1; no other delegatecall target is ever produced here.
 */
export function buildAddLiquidityCall(chainId: number, safe: Address, plan: LiquidityPlan): PreparedCall {
  const { uniswapV4, safe: safeConfig } = getChainConfig(chainId);
  const { poolKey } = plan;
  const tokens = [[poolKey.currency0, plan.amount0Max], [poolKey.currency1, plan.amount1Max]] as const;
  if (plan.amount0Max >= 1n << 128n || plan.amount1Max >= 1n << 128n) throw new Error("Amount too large");

  const mintParams = encodeAbiParameters(
    [POOL_KEY, { type: "int24" }, { type: "int24" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }, { type: "address" }, { type: "bytes" }],
    [poolKey, plan.tickLower, plan.tickUpper, plan.liquidity, plan.amount0Max, plan.amount1Max, getAddress(safe), "0x"],
  );
  const settleParams = encodeAbiParameters([{ type: "address" }, { type: "address" }], [poolKey.currency0, poolKey.currency1]);
  const unlockData = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], [
    encodePacked(["uint8", "uint8"], [MINT_POSITION, SETTLE_PAIR]),
    [mintParams, settleParams],
  ]);

  const entries: Hex[] = [];
  for (const [token, max] of tokens) {
    entries.push(multiSendEntry(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [uniswapV4.permit2, max] })));
    // The Permit2 allowance never expires on its own; the token approval reset below is what closes it.
    entries.push(multiSendEntry(uniswapV4.permit2, encodeFunctionData({ abi: permit2Abi, functionName: "approve", args: [token, uniswapV4.positionManager, max, Number(maxUint48)] })));
  }
  // No deadline: the batch only runs once the owners execute it, and the amount caps bound any price move.
  entries.push(multiSendEntry(uniswapV4.positionManager, encodeFunctionData({ abi: positionManagerAbi, functionName: "modifyLiquidities", args: [unlockData, maxUint256] })));
  for (const [token] of tokens) entries.push(multiSendEntry(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [uniswapV4.permit2, 0n] })));

  return {
    chainId,
    to: safeConfig.multiSendCallOnly,
    data: encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [concat(entries)] }),
    value: 0n,
    operation: 1,
    role: "issuer-safe",
  };
}

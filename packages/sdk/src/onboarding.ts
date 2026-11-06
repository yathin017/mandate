import { getChainConfig } from "@mandate/chains";
import {
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  type Address,
  type Hash,
  type Hex,
  type PublicClient,
} from "viem";

import { anchorLauncherAbi, erc20MetadataAbi, mandateOracleHookAbi, mockErc20Abi, mockErc20Bytecode, safeAbi,
  safeProxyFactoryAbi, stateViewAbi } from "./abis.ts";
import type { PreparedCall } from "./transactions.ts";

/**
 * Self-serve onboarding helpers: Safe creation, module enablement, token checks, demo mock tokens and the
 * AnchorLauncher. Builders never sign or send; reads take an explicit client and never fall back to defaults.
 */

/** Pool parameters every AnchorLauncher pool uses (mirrors AnchorLauncher.FEE / TICK_SPACING onchain). */
export const ANCHOR_POOL_FEE = 3000;
export const ANCHOR_POOL_TICK_SPACING = 60;

const PRICE_SCALE = 10n ** 36n;
const Q64 = 1n << 64n;
const Q128 = 1n << 128n;

const prepared = (chainId: number, to: Address, data: Hex, role: PreparedCall["role"]): PreparedCall =>
  ({ chainId, to, data, value: 0n, operation: 0, role });

// ---------------------------------------------------------------- v4 anchor pool

export interface PoolKey {
  readonly currency0: Address;
  readonly currency1: Address;
  readonly fee: number;
  readonly tickSpacing: number;
  readonly hooks: Address;
}

/** The AnchorLauncher pool key for a pair: sorted currencies, launcher fee/spacing, Mandate oracle hook. */
export function anchorPoolKey(hook: Address, base: Address, quote: Address): PoolKey {
  const [currency0, currency1] = BigInt(base) < BigInt(quote) ? [base, quote] : [quote, base];
  return { currency0: getAddress(currency0), currency1: getAddress(currency1), fee: ANCHOR_POOL_FEE,
    tickSpacing: ANCHOR_POOL_TICK_SPACING, hooks: getAddress(hook) };
}

/** v4 PoolId = keccak256(abi.encode(PoolKey)). */
export function poolIdOf(key: PoolKey): Hash {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
  ));
}

/** Price of base in quote (`quoteRaw * 1e36 / baseRaw`) from a pool's sqrtPriceX96. Rounds down. */
export function priceX36FromSqrtPrice(sqrtPriceX96: bigint, baseIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 <= 0n) return 0n;
  const priceX128 = (sqrtPriceX96 * sqrtPriceX96) / Q64; // currency1 per currency0, Q128
  if (priceX128 === 0n) return 0n;
  return baseIsCurrency0 ? (priceX128 * PRICE_SCALE) / Q128 : (PRICE_SCALE * Q128) / priceX128;
}

/** Creates the pool (if missing) and anchor for `base` priced in `quote`. Anyone may send it. */
export function buildLaunchAnchorCall(chainId: number, launcher: Address,
  input: { base: Address; quote: Address; initialPriceX36: bigint }): PreparedCall {
  if (input.initialPriceX36 <= 0n) throw new Error("Initial price must be positive");
  return prepared(chainId, launcher, encodeFunctionData({ abi: anchorLauncherAbi, functionName: "launch",
    args: [input.base, input.quote, input.initialPriceX36] }), "anyone");
}

export interface AnchorStatus {
  readonly poolId: Hash;
  readonly poolKey: PoolKey;
  /** Anchor deployed by the launcher for this orientation, or null. */
  readonly anchor: Address | null;
  /** Where `launch` deploys (or deployed) the anchor. */
  readonly predictedAnchor: Address;
  readonly poolExists: boolean;
  readonly sqrtPriceX96: bigint;
  readonly tick: number;
  /** Current pool price of base in quote; 0 when the pool does not exist. */
  readonly spotPriceX36: bigint;
  /** In-range liquidity; an anchor on a thin pool is cheap to move. */
  readonly liquidity: bigint;
  /**
   * Liquidity the hook trusts: recent additions do not count until they have settled, so a just-in-time deposit
   * cannot inflate the depth the policy's risk checks see.
   */
  readonly trustedLiquidity: bigint;
  /** When the pool was initialized (hook record), or null if it does not exist. */
  readonly initializedAt: number | null;
  readonly cardinality: number;
  readonly cardinalityNext: number;
  /** Timestamp of the oldest stored observation, or null without history. */
  readonly oldestObservation: number | null;
  /** Seconds of price history the pool has now (0 without any). */
  readonly historySeconds: number;
  /** When the issuer's TWAP window is first fully covered; null without history or without a window. */
  readonly readyAt: number | null;
  /** Whether the window is covered now; null when no window was given (no policy yet). */
  readonly ready: boolean | null;
  readonly source: { readonly blockNumber: bigint; readonly timestamp: bigint };
}

/** Everything the onboarding UI shows about a pair's anchor, read at one block. */
export async function readAnchorStatus(client: PublicClient, input: {
  chainId: number; launcher: Address; base: Address; quote: Address;
  /** The policy's TWAP window in seconds, when there is a policy; it decides when the anchor is ready. */
  window?: number;
}): Promise<AnchorStatus> {
  const block = await client.getBlock({ blockTag: "latest" });
  if (block.number === null) throw new Error("A confirmed block is required");
  const at = { blockNumber: block.number };
  const stateView = getChainConfig(input.chainId).uniswapV4.stateView;
  const hook = await client.readContract({ address: input.launcher, abi: anchorLauncherAbi, functionName: "HOOK", ...at });
  const poolKey = anchorPoolKey(hook, input.base, input.quote);
  const poolId = poolIdOf(poolKey);

  const [anchor, predictedAnchor, slot0, liquidity, state, trustedLiquidity, initializedAt] = await Promise.all([
    client.readContract({ address: input.launcher, abi: anchorLauncherAbi, functionName: "anchorOf", args: [input.base, input.quote], ...at }),
    client.readContract({ address: input.launcher, abi: anchorLauncherAbi, functionName: "predictAnchor", args: [input.base, input.quote], ...at }),
    client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getSlot0", args: [poolId], ...at }),
    client.readContract({ address: stateView, abi: stateViewAbi, functionName: "getLiquidity", args: [poolId], ...at }),
    client.readContract({ address: hook, abi: mandateOracleHookAbi, functionName: "stateById", args: [poolId], ...at }),
    client.readContract({ address: hook, abi: mandateOracleHookAbi, functionName: "trustedLiquidity", args: [poolId], ...at }),
    client.readContract({ address: hook, abi: mandateOracleHookAbi, functionName: "initializedAt", args: [poolId], ...at }),
  ]);
  const [sqrtPriceX96, tick] = slot0;
  const [index, cardinality, cardinalityNext] = state;

  // Oldest observation: the slot after the newest one, unless it was never written (then slot 0).
  let oldestObservation: number | null = null;
  if (cardinality > 0) {
    const next = await client.readContract({ address: hook, abi: mandateOracleHookAbi, functionName: "observationsById",
      args: [poolId, BigInt((index + 1) % cardinality)], ...at });
    const oldest = next[4] ? next : await client.readContract({ address: hook, abi: mandateOracleHookAbi,
      functionName: "observationsById", args: [poolId, 0n], ...at });
    if (oldest[4]) oldestObservation = oldest[0];
  }
  const { window } = input;
  if (window !== undefined && (!Number.isInteger(window) || window <= 0)) throw new Error("TWAP window must be a positive number of seconds");
  const readyAt = oldestObservation === null || window === undefined ? null : oldestObservation + window;
  const baseIsCurrency0 = getAddress(input.base) === poolKey.currency0;

  return {
    poolId, poolKey,
    anchor: /^0x0{40}$/i.test(anchor) ? null : getAddress(anchor),
    predictedAnchor: getAddress(predictedAnchor),
    poolExists: sqrtPriceX96 > 0n, sqrtPriceX96, tick,
    spotPriceX36: priceX36FromSqrtPrice(sqrtPriceX96, baseIsCurrency0),
    liquidity, trustedLiquidity, initializedAt: initializedAt === 0 ? null : initializedAt,
    cardinality, cardinalityNext, oldestObservation, readyAt,
    historySeconds: oldestObservation === null ? 0 : Math.max(0, Number(block.timestamp) - oldestObservation),
    ready: window === undefined ? null : readyAt !== null && BigInt(readyAt) <= block.timestamp,
    source: { blockNumber: block.number, timestamp: block.timestamp },
  };
}

// ---------------------------------------------------------------- Safe

/** Safe 1.4.1 `setup` calldata: owners and threshold only (no delegatecall, fallback handler or payment). */
export function encodeSafeSetup(owners: readonly Address[], threshold: number): Hex {
  if (owners.length === 0) throw new Error("A Safe needs at least one owner");
  const unique = new Set(owners.map((o) => {
    if (!isAddress(o) || /^0x0{40}$/i.test(o)) throw new Error(`Invalid owner address: ${o}`);
    return o.toLowerCase();
  }));
  if (unique.size !== owners.length) throw new Error("Owners must be unique");
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > owners.length) {
    throw new Error(`Threshold must be between 1 and ${owners.length}`);
  }
  const zero = "0x0000000000000000000000000000000000000000";
  return encodeFunctionData({ abi: safeAbi, functionName: "setup",
    args: [owners.map((o) => getAddress(o)), BigInt(threshold), zero, "0x", zero, zero, 0n, zero] });
}

/** Deploys a Safe proxy through the chain's canonical factory and singleton (from config/chains). */
export function buildCreateSafeCall(chainId: number,
  input: { owners: readonly Address[]; threshold: number; saltNonce: bigint }): PreparedCall {
  const { safe } = getChainConfig(chainId);
  return prepared(chainId, safe.proxyFactory, encodeFunctionData({ abi: safeProxyFactoryAbi,
    functionName: "createProxyWithNonce", args: [safe.singletonL2, encodeSafeSetup(input.owners, input.threshold), input.saltNonce] }), "anyone");
}

/** The Safe enables the Mandate module on itself; execute it as a Safe transaction approved by the owners. */
export function buildEnableModuleCall(chainId: number, safe: Address, module: Address): PreparedCall {
  return prepared(chainId, safe, encodeFunctionData({ abi: safeAbi, functionName: "enableModule", args: [module] }), "issuer-safe");
}

// ---------------------------------------------------------------- tokens

export type TokenInfo =
  | { readonly ok: true; readonly address: Address; readonly name: string; readonly symbol: string;
      readonly decimals: number; readonly totalSupply: bigint }
  | { readonly ok: false; readonly address: Address; readonly reason: string };

/** Reads ERC20 metadata; anything that does not answer like an ERC20 is reported, never guessed. */
export async function readTokenInfo(client: PublicClient, token: Address): Promise<TokenInfo> {
  const address = getAddress(token);
  const code = await client.getCode({ address });
  if (!code || code === "0x") return { ok: false, address, reason: "No contract at this address." };
  try {
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      client.readContract({ address, abi: erc20MetadataAbi, functionName: "name" }),
      client.readContract({ address, abi: erc20MetadataAbi, functionName: "symbol" }),
      client.readContract({ address, abi: erc20MetadataAbi, functionName: "decimals" }),
      client.readContract({ address, abi: erc20MetadataAbi, functionName: "totalSupply" }),
    ]);
    return { ok: true, address, name: printable(name), symbol: printable(symbol), decimals: Number(decimals), totalSupply };
  } catch {
    return { ok: false, address, reason: "This contract does not behave like an ERC20 token." };
  }
}

const printable = (value: string) => value.replace(/[^\x20-\x7e]/g, "").slice(0, 64);

/** Symbols people trust by name; any other address using them is flagged. */
const TRUSTED_SYMBOLS = ["USDC", "USDT", "DAI", "WETH", "ETH", "WBTC"];

export interface TokenLabel {
  /** Set for the chain's canonical USDC / WETH (from config/chains). */
  readonly canonical: "USDC" | "WETH" | null;
  /** Plain-language warning when a non-canonical token uses a trusted symbol. */
  readonly warning: string | null;
}

export function labelToken(chainId: number, address: Address, symbol: string): TokenLabel {
  const { tokens } = getChainConfig(chainId);
  const a = address.toLowerCase();
  if (a === tokens.usdc.toLowerCase()) return { canonical: "USDC", warning: null };
  if (a === tokens.weth.toLowerCase()) return { canonical: "WETH", warning: null };
  const normalized = symbol.toUpperCase().replace(/[^A-Z]/g, "");
  const imitated = TRUSTED_SYMBOLS.find((s) => normalized === s || normalized.includes(s));
  return { canonical: null, warning: imitated
    ? `This token calls itself ${symbol} but is not the canonical ${imitated} on this chain. Double-check the address.`
    : null };
}

// ---------------------------------------------------------------- demo mock tokens

/** Deployment request for a clearly labelled, owner-mintable demo token (no value). Names must start with "Demo ". */
export function mockTokenDeployment(name: string, symbol: string, decimals: number) {
  if (!/^Demo [\x20-\x7e]{1,40}$/.test(name)) throw new Error('Mock token names must start with "Demo "');
  if (!/^[A-Za-z0-9]{1,11}$/.test(symbol)) throw new Error("Symbol: 1-11 letters or digits");
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("Decimals: 0-36");
  return { abi: mockErc20Abi, bytecode: mockErc20Bytecode, args: [name, symbol, decimals] as const };
}

/** Mints a demo token; only its deployer (owner) can send this. */
export function buildMintCall(chainId: number, token: Address, to: Address, amount: bigint): PreparedCall {
  if (amount <= 0n) throw new Error("Mint amount must be positive");
  return prepared(chainId, token, encodeFunctionData({ abi: mockErc20Abi, functionName: "mint", args: [to, amount] }), "token-owner");
}

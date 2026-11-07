import type { StrategyBounds, StrategyParams } from "@mandate/sdk";
import { getAddress, isAddress, type Address } from "viem";

import { parseUnits } from "../lib/format.ts";

/**
 * A strategy as the issuer types it, and its conversion into the module's StrategyBounds and StrategyParams. A
 * strategy is one market maker's Aqua order under the Safe's treasury policy: the bounds are the market maker's
 * rails (spread range, most inventory, fee share, and for buybacks the highest price), the params its first order.
 *
 * Every value is the issuer's decision: nothing here supplies a default. Pure (no React, no chain reads) so the
 * conversion is unit-tested and every owner builds identical calldata. Imports are relative so `node --test` can
 * load this file directly.
 */

/** "marketMaking" sells and buys back around the price; "buyback" only buys, at or below a set price. */
export type StrategyKindName = "marketMaking" | "buyback";
export const KIND_INDEX: Record<StrategyKindName, number> = { marketMaking: 0, buyback: 1 };

/** Human-entered strategy. Every value is a string exactly as typed. */
export interface Terms {
  mm: string;
  kind: string;
  spreadMinPct: string;
  spreadMaxPct: string;
  feeSharePct: string;
  maxShippedBase: string;
  maxShippedQuote: string;
  /** Buyback strategies only: the highest price the treasury pays. */
  maxBuyPrice: string;
  spreadPct: string;
  shippedBase: string;
  shippedQuote: string;
}

export const TERM_KEYS = [
  "mm", "kind", "spreadMinPct", "spreadMaxPct", "feeSharePct", "maxShippedBase", "maxShippedQuote", "maxBuyPrice",
  "spreadPct", "shippedBase", "shippedQuote",
] as const satisfies readonly (keyof Terms)[];

export const EMPTY_TERMS: Terms = Object.fromEntries(TERM_KEYS.map((k) => [k, ""])) as unknown as Terms;

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
}

/**
 * What the Safe can still back: its balances minus what its other live strategies already committed in Aqua.
 * Shipping more makes the module refuse with InsufficientBacking.
 */
export interface Holdings {
  base?: bigint;
  quote?: bigint;
}

/** The parts of the Safe's policy a strategy is checked against before anyone signs. */
export interface PolicyRules {
  floorPriceX36: bigint;
  maxQuoteDeviationBps: number;
}

export interface BuiltTerms {
  marketMaker: Address;
  kind: number;
  bounds: StrategyBounds;
  params: StrategyParams;
  /** Non-blocking observations the owners should see before approving. */
  warnings: string[];
}

/** UTC date string for a unix timestamp (seconds). */
export function utcDate(seconds: bigint): string {
  return new Date(Number(seconds) * 1000).toISOString().slice(0, 10);
}

/** Unix timestamp (seconds) of 00:00 UTC on a YYYY-MM-DD date, or null when the date is not real. */
export function parseUtcDate(value: string): bigint | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  // Date.UTC rolls 2026-02-31 over to March; reject anything that does not round-trip.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value.trim()) return null;
  return BigInt(ms / 1000);
}

/** Price in quote per base (human) to the module's X36 unit: quoteRaw * 1e36 / baseRaw. Null if not a number. */
export function priceToX36(price: string, base: TokenRef, quote: TokenRef): bigint | null {
  const scaled = parseUnits(price, 18);
  if (scaled === null) return null;
  return (scaled * 10n ** 36n * 10n ** BigInt(quote.decimals)) / (10n ** 18n * 10n ** BigInt(base.decimals));
}

/**
 * Converts terms into the addStrategy arguments, or returns the first problem as a plain sentence. The rules mirror
 * MandateModule._validateStrategyBounds / _validateParams and the backing check; the module re-checks them onchain.
 */
export function buildTerms(
  terms: Terms,
  ctx: {
    safe: Address;
    owners?: readonly Address[];
    base: TokenRef;
    quote: TokenRef;
    holdings?: Holdings;
    /** The anchor pool's current price (X36). With `policy`, the starting price is checked against it. */
    anchorPriceX36?: bigint;
    policy?: PolicyRules;
  },
): { error: string } | BuiltTerms {
  const { base, quote, holdings } = ctx;
  const amount = (v: string, t: TokenRef, name: string) => {
    const raw = parseUnits(v, t.decimals);
    if (raw === null || raw === 0n) throw new Error(`${name}: enter a positive amount (at most ${t.decimals} decimals)`);
    return raw;
  };
  const bps = (v: string, name: string) => {
    const raw = parseUnits(v, 2);
    if (raw === null || raw > 10_000n) throw new Error(`${name}: enter a percentage between 0 and 100`);
    return Number(raw);
  };
  /** The two ways to ship at `targetX36`: more quote for the same base, or less base for the same quote. */
  const rebalance = (targetX36: bigint) => {
    const sb = parseUnits(terms.shippedBase, base.decimals) ?? 0n;
    const sq = parseUnits(terms.shippedQuote, quote.decimals) ?? 0n;
    return `ship about ${fmt((sb * targetX36) / 10n ** 36n, quote, 2)} ${quote.symbol} with this inventory, or about ${fmt((sq * 10n ** 36n) / targetX36, base, 2)} ${base.symbol} with this quote inventory`;
  };
  try {
    if (!isAddress(terms.mm)) throw new Error("Market maker address: not a valid address");
    const marketMaker = getAddress(terms.mm);
    if (marketMaker === getAddress(ctx.safe)) throw new Error("Market maker address: cannot be the Safe itself");
    if (terms.kind !== "marketMaking" && terms.kind !== "buyback") throw new Error("Strategy kind: choose market making or buyback");
    const kind = KIND_INDEX[terms.kind];
    const spreadMin = bps(terms.spreadMinPct, "Minimum spread");
    const spreadMax = bps(terms.spreadMaxPct, "Maximum spread");
    const spread = bps(terms.spreadPct, "Initial spread");
    const feeShare = bps(terms.feeSharePct, "MM fee share");
    const maxShippedBase = amount(terms.maxShippedBase, base, "Most token inventory");
    const maxShippedQuote = amount(terms.maxShippedQuote, quote, "Most quote inventory");
    const shippedBase = amount(terms.shippedBase, base, "Initial token inventory");
    const shippedQuote = amount(terms.shippedQuote, quote, "Initial quote inventory");
    let maxBuyPriceX36 = 0n;
    if (kind === KIND_INDEX.buyback) {
      const price = priceToX36(terms.maxBuyPrice, base, quote);
      if (price === null || price === 0n) throw new Error("Highest buyback price: enter a positive price");
      maxBuyPriceX36 = price;
    }

    // Same rules as the module, phrased for the form.
    if (spreadMin > spreadMax) throw new Error("Minimum spread: must not exceed the maximum spread");
    if (spreadMax >= 10_000) throw new Error("Maximum spread: must be below 100%");
    if (spread < spreadMin || spread > spreadMax) throw new Error("Initial spread: must be within the spread range");
    if (shippedBase > maxShippedBase) throw new Error("Initial token inventory: cannot exceed the most token inventory");
    if (shippedQuote > maxShippedQuote) throw new Error("Initial quote inventory: cannot exceed the most quote inventory");
    if (holdings?.base !== undefined && shippedBase > holdings.base)
      throw new Error(`Initial token inventory: the Safe can back only ${fmt(holdings.base, base)} ${base.symbol} more`);
    if (holdings?.quote !== undefined && shippedQuote > holdings.quote)
      throw new Error(`Initial quote inventory: the Safe can back only ${fmt(holdings.quote, quote)} ${quote.symbol} more`);

    // Fills are priced over the shipped balances (constant product), so their ratio is the starting price. Too far
    // from the market and every fill fails QuoteOffMarket; below the floor and every sell fails BelowFloor.
    const startX36 = (shippedQuote * 10n ** 36n) / shippedBase;
    if (ctx.policy && kind === KIND_INDEX.marketMaking && startX36 < ctx.policy.floorPriceX36)
      throw new Error(`Starting price: ${shownPrice(startX36, base, quote)} is below the policy's floor, so every sell would be refused; ${rebalance(ctx.anchorPriceX36 ?? ctx.policy.floorPriceX36)}`);
    if (ctx.policy && ctx.anchorPriceX36 !== undefined && ctx.anchorPriceX36 > 0n) {
      const diff = startX36 > ctx.anchorPriceX36 ? startX36 - ctx.anchorPriceX36 : ctx.anchorPriceX36 - startX36;
      if (diff * 10_000n > ctx.anchorPriceX36 * BigInt(ctx.policy.maxQuoteDeviationBps))
        throw new Error(`Starting price: ${shownPrice(startX36, base, quote)} is outside the policy's quote tolerance of the pool price ${shownPrice(ctx.anchorPriceX36, base, quote)}, so every fill would be refused; ${rebalance(ctx.anchorPriceX36)}`);
    }

    const warnings: string[] = [];
    if (ctx.owners?.some((o) => getAddress(o) === marketMaker))
      warnings.push("The market maker is also an owner of this Safe, so the issuer and the market maker are not separated.");
    if (kind === KIND_INDEX.buyback)
      warnings.push("A buyback strategy never sells: its token inventory only prices the curve and is not sold.");

    return {
      marketMaker,
      kind,
      bounds: { spreadBpsMin: spreadMin, spreadBpsMax: spreadMax, maxShippedBase, maxShippedQuote, mmFeeShareBps: feeShare, maxBuyPriceX36 },
      params: { spreadBps: spread, shippedBase, shippedQuote },
      warnings,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Human price (quote per base, up to 6 decimals) for messages. */
function shownPrice(x36: bigint, base: TokenRef, quote: TokenRef): string {
  const micro = (x36 * 10n ** BigInt(base.decimals) * 1_000_000n) / (10n ** 36n * 10n ** BigInt(quote.decimals));
  return `${fmt(micro, { address: base.address, symbol: "", decimals: 6 })} ${quote.symbol} per ${base.symbol}`;
}

/** Plain decimal for error messages (no grouping, so it can be pasted back into the field). */
function fmt(raw: bigint, token: TokenRef, maxFraction = token.decimals): string {
  const unit = 10n ** BigInt(token.decimals);
  const fraction = (raw % unit).toString().padStart(token.decimals, "0").slice(0, maxFraction).replace(/0+$/, "");
  return fraction ? `${raw / unit}.${fraction}` : `${raw / unit}`;
}

/**
 * Strategy terms travel in the page URL so every co-owner opens the same link and builds the same Safe transaction.
 * Decoding is defensive: the link may come from anyone, so only known string fields are kept, and the owners
 * still review every decoded term before approving.
 */
export function encodeTerms(terms: Terms): string {
  return JSON.stringify(Object.fromEntries(TERM_KEYS.map((k) => [k, terms[k]])));
}

export function decodeTerms(value: string | null): Partial<Terms> | null {
  if (!value || value.length > 4096) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Partial<Terms> = {};
    for (const key of TERM_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length <= 100) out[key] = v;
    }
    return out;
  } catch {
    return null;
  }
}

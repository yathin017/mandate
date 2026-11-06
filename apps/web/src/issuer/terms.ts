import type { IssuerBounds, MandateParams } from "@mandate/sdk";
import { getAddress, isAddress, type Address } from "viem";

import { parseUnits } from "../lib/format.ts";

/**
 * Mandate terms as the issuer types them, and their conversion into the module's bounds and params.
 * Pure (no React, no chain reads) so the conversion is unit-tested and every owner builds identical calldata
 * from the same terms. Imports are relative so `node --test` can load this file directly.
 */

/** Human-entered terms. Every value is a string exactly as typed; nothing here depends on chain time. */
export interface Terms {
  mm: string;
  allotment: string;
  /** UTC date (YYYY-MM-DD) from which inventory unlocks; may be in the past or the future. */
  releaseStart: string;
  releaseDays: string;
  dailyCap: string;
  floor: string;
  anchorPct: string;
  spreadMinPct: string;
  spreadMaxPct: string;
  spreadPct: string;
  feeSharePct: string;
  shippedBase: string;
  shippedQuote: string;
}

export const TERM_KEYS = [
  "mm", "allotment", "releaseStart", "releaseDays", "dailyCap", "floor", "anchorPct",
  "spreadMinPct", "spreadMaxPct", "spreadPct", "feeSharePct", "shippedBase", "shippedQuote",
] as const satisfies readonly (keyof Terms)[];

/** Risk rails that do not depend on the token: mirror contracts/script/lib/DemoConfig.sol. */
export const STANDARD_RAILS = {
  releaseDays: "180",
  anchorPct: "3",
  spreadMinPct: "0.1",
  spreadMaxPct: "2",
  spreadPct: "0.8",
  feeSharePct: "50",
} as const satisfies Partial<Terms>;

/** Fixed for every mandate built here: one-day epochs and the anchor launcher's 30-minute TWAP window. */
export const EPOCH_LENGTH = 86_400n;
export const TWAP_WINDOW = 1800;

export interface TokenRef {
  address: Address;
  symbol: string;
  decimals: number;
}

/** What the Safe holds now; shipping more than this would let fills fail at transfer time. */
export interface Holdings {
  base?: bigint;
  quote?: bigint;
}

export interface BuiltTerms {
  marketMaker: Address;
  bounds: IssuerBounds;
  params: MandateParams;
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
 * Converts terms into the createMandate arguments, or returns the first problem as a plain sentence.
 * The module re-validates every bound onchain; checks here exist to explain a refusal before anyone approves.
 */
export function buildTerms(
  terms: Terms,
  ctx: { safe: Address; owners?: readonly Address[]; base: TokenRef; quote: TokenRef; anchor: Address; holdings?: Holdings },
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
  const days = (v: string, name: string) => {
    if (!/^\d{1,4}$/.test(v.trim()) || BigInt(v.trim()) === 0n) throw new Error(`${name}: whole days, at least 1`);
    return BigInt(v.trim()) * 86_400n;
  };
  try {
    if (!isAddress(terms.mm)) throw new Error("Market maker address: not a valid address");
    const marketMaker = getAddress(terms.mm);
    if (marketMaker === getAddress(ctx.safe)) throw new Error("Market maker address: cannot be the Safe itself");
    const releaseStart = parseUtcDate(terms.releaseStart);
    if (releaseStart === null) throw new Error("Release start: enter a date as YYYY-MM-DD");
    const floorPriceX36 = priceToX36(terms.floor, base, quote);
    if (floorPriceX36 === null) throw new Error("Price floor: enter a price");
    const allotment = amount(terms.allotment, base, "Allotment");
    const dailyCap = amount(terms.dailyCap, base, "Daily sell limit");
    const shippedBase = amount(terms.shippedBase, base, "Initial inventory");
    const shippedQuote = amount(terms.shippedQuote, quote, "Buyback inventory");
    const anchorBps = bps(terms.anchorPct, "Anchor tolerance");
    const spreadMin = bps(terms.spreadMinPct, "Minimum spread");
    const spreadMax = bps(terms.spreadMaxPct, "Maximum spread");
    const spread = bps(terms.spreadPct, "Initial spread");

    // Same rules as MandateModule._validateBounds / _validateParams, phrased for the form.
    if (spreadMin > spreadMax) throw new Error("Minimum spread: must not exceed the maximum spread");
    if (spreadMax >= anchorBps) throw new Error("Maximum spread: must stay below the anchor tolerance");
    if (spread < spreadMin || spread > spreadMax) throw new Error("Initial spread: must be within the spread range");
    if (shippedBase > allotment) throw new Error("Initial inventory: cannot exceed the allotment");
    if (holdings?.base !== undefined && shippedBase > holdings.base)
      throw new Error(`Initial inventory: the Safe holds only ${fmt(holdings.base, base)} ${base.symbol}`);
    if (holdings?.quote !== undefined && shippedQuote > holdings.quote)
      throw new Error(`Buyback inventory: the Safe holds only ${fmt(holdings.quote, quote)} ${quote.symbol}`);

    const warnings: string[] = [];
    if (ctx.owners?.some((o) => getAddress(o) === marketMaker))
      warnings.push("The market maker is also an owner of this Safe, so the issuer and the market maker are not separated.");
    if (holdings?.base !== undefined && allotment > holdings.base)
      warnings.push(`The allotment exceeds the Safe's ${base.symbol} balance; fund the Safe before inventory beyond it can be shipped.`);

    return {
      marketMaker,
      bounds: {
        allotment,
        releaseStart,
        releaseDuration: days(terms.releaseDays, "Release duration"),
        epochLength: EPOCH_LENGTH,
        maxEpochCap: dailyCap,
        maxShippedQuote: shippedQuote,
        floorPriceX36,
        maxAnchorDeviationBps: anchorBps,
        twapWindow: TWAP_WINDOW,
        spreadBpsMin: spreadMin,
        spreadBpsMax: spreadMax,
        mmFeeShareBps: bps(terms.feeSharePct, "MM fee share"),
        anchor: ctx.anchor,
      },
      params: { spreadBps: spread, epochCap: dailyCap, shippedBase, shippedQuote },
      warnings,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/** Plain decimal for error messages (no grouping, so it can be pasted back into the field). */
function fmt(raw: bigint, token: TokenRef): string {
  const unit = 10n ** BigInt(token.decimals);
  const fraction = (raw % unit).toString().padStart(token.decimals, "0").replace(/0+$/, "");
  return fraction ? `${raw / unit}.${fraction}` : `${raw / unit}`;
}

/**
 * Terms travel in the page URL so every co-owner opens the same link and builds the same Safe transaction.
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

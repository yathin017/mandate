import type { PolicyConfig } from "@mandate/sdk";
import { getAddress, isAddress, type Address } from "viem";

import { formatUnits, parseUnits } from "../lib/format.ts";
import { parseUtcDate, priceToX36, utcDate, type TokenRef } from "./terms.ts";

/**
 * A treasury policy as the issuer types it, and its conversion into the module's PolicyConfig. One policy per Safe
 * and token holds the treasury-wide budget every strategy shares: release schedule, per-period sell and buyback
 * limits, price rules, the market-risk thresholds read from the Uniswap oracle, and what each risk mode allows.
 *
 * Every value is the issuer's decision: this conversion never supplies a default (suggestions live in explain.ts). Pure (no React,
 * no chain reads) so the conversion is unit-tested and every owner builds identical calldata. Imports are relative
 * so `node --test` can load this file directly.
 */

/** Human-entered policy. Every value is a string exactly as typed. */
export interface PolicyTerms {
  allotment: string;
  /** UTC date (YYYY-MM-DD) from which inventory unlocks; may be in the past or the future. */
  releaseStart: string;
  releaseDays: string;
  periodHours: string;
  grossCap: string;
  netCap: string;
  quoteSpendCap: string;
  floor: string;
  quoteDeviationPct: string;
  impactPct: string;
  twapMinutes: string;
  shortTwapMinutes: string;
  depthBandPct: string;
  minPoolAgeHours: string;
  minDepth: string;
  defensiveDepth: string;
  defensiveMovePct: string;
  pauseMovePct: string;
  defensiveVolatilityPct: string;
  pauseVolatilityPct: string;
  normalMaxFill: string;
  normalDepthSharePct: string;
  normalMinSpreadPct: string;
  /** "yes" or "no". */
  normalBuybacks: string;
  defensiveMaxFill: string;
  defensiveDepthSharePct: string;
  defensiveMinSpreadPct: string;
  defensiveBuybacks: string;
}

export const POLICY_KEYS = [
  "allotment", "releaseStart", "releaseDays", "periodHours", "grossCap", "netCap", "quoteSpendCap", "floor",
  "quoteDeviationPct", "impactPct", "twapMinutes", "shortTwapMinutes", "depthBandPct", "minPoolAgeHours", "minDepth",
  "defensiveDepth", "defensiveMovePct", "pauseMovePct", "defensiveVolatilityPct", "pauseVolatilityPct",
  "normalMaxFill", "normalDepthSharePct", "normalMinSpreadPct", "normalBuybacks", "defensiveMaxFill",
  "defensiveDepthSharePct", "defensiveMinSpreadPct", "defensiveBuybacks",
] as const satisfies readonly (keyof PolicyTerms)[];

export const EMPTY_POLICY: PolicyTerms = Object.fromEntries(POLICY_KEYS.map((k) => [k, ""])) as unknown as PolicyTerms;

export interface BuiltPolicy {
  config: PolicyConfig;
  /** Non-blocking observations the owners should see before approving. */
  warnings: string[];
}

/**
 * Converts a typed policy into the createPolicy / updatePolicy argument, or returns the first problem as a plain
 * sentence. The rules mirror MandateModule._validatePolicy; the module re-checks them onchain.
 */
export function buildPolicy(
  terms: PolicyTerms,
  ctx: { base: TokenRef; quote: TokenRef; oracle: Address; holdings?: { base?: bigint } },
): { error: string } | BuiltPolicy {
  const { base, quote } = ctx;
  const amount = (v: string, t: TokenRef, name: string, allowZero = false) => {
    const raw = parseUnits(v, t.decimals);
    if (raw === null || (!allowZero && raw === 0n)) throw new Error(`${name}: enter a ${allowZero ? "" : "positive "}amount (at most ${t.decimals} decimals)`);
    return raw;
  };
  const bps = (v: string, name: string, { max = 100, positive = false } = {}) => {
    const raw = parseUnits(v, 2);
    if (raw === null || raw > BigInt(max * 100) || (positive && raw === 0n))
      throw new Error(`${name}: enter a percentage ${positive ? "above 0 and " : "from 0 "}up to ${max}`);
    return Number(raw);
  };
  const whole = (v: string, name: string, unit: string, scale: bigint, max: bigint, allowZero = false) => {
    if (!/^\d{1,9}$/.test(v.trim()) || (!allowZero && BigInt(v.trim()) === 0n))
      throw new Error(`${name}: whole ${unit}, at least ${allowZero ? 0 : 1}`);
    const seconds = BigInt(v.trim()) * scale;
    if (seconds > max) throw new Error(`${name}: too long`);
    return seconds;
  };
  const yesNo = (v: string, name: string) => {
    if (v !== "yes" && v !== "no") throw new Error(`${name}: choose whether buybacks are allowed`);
    return v === "yes";
  };
  try {
    if (!isAddress(ctx.oracle)) throw new Error("Market oracle: launch the anchor first");
    const releaseStart = parseUtcDate(terms.releaseStart);
    if (releaseStart === null) throw new Error("Release start: enter a date as YYYY-MM-DD");
    const floorPriceX36 = terms.floor.trim() === "" || terms.floor.trim() === "0" ? 0n : priceToX36(terms.floor, base, quote);
    if (floorPriceX36 === null) throw new Error("Price floor: enter a price, or 0 for none");

    const allotment = amount(terms.allotment, base, "Allotment");
    const grossSellCap = amount(terms.grossCap, base, "Gross sell limit");
    const netSellCap = amount(terms.netCap, base, "Net sell limit");
    const quoteSpendCap = amount(terms.quoteSpendCap, quote, "Buyback budget", true);
    const uint32Max = 2n ** 32n - 1n;
    const twapWindow = whole(terms.twapMinutes, "TWAP window", "minutes", 60n, uint32Max);
    const shortWindow = whole(terms.shortTwapMinutes, "Short TWAP window", "minutes", 60n, uint32Max);
    // 0 is valid onchain: the pool's age is then not checked (the TWAP history and trusted depth still are).
    const minPoolAge = whole(terms.minPoolAgeHours, "Minimum pool age", "hours", 3600n, uint32Max, true);
    const minTrustedDepth = amount(terms.minDepth, base, "Minimum depth", true);
    const defensiveDepth = amount(terms.defensiveDepth, base, "Defensive depth", true);
    const defensiveMoveBps = bps(terms.defensiveMovePct, "Defensive price move", { max: 655 });
    const pauseMoveBps = bps(terms.pauseMovePct, "Pause price move", { max: 655 });
    const defensiveVolatilityBps = bps(terms.defensiveVolatilityPct, "Defensive volatility", { max: 655 });
    const pauseVolatilityBps = bps(terms.pauseVolatilityPct, "Pause volatility", { max: 655 });
    const depthBandBps = bps(terms.depthBandPct, "Depth band", { positive: true });
    const normal = {
      maxFillBase: amount(terms.normalMaxFill, base, "Normal mode: largest fill"),
      maxFillDepthBps: bps(terms.normalDepthSharePct, "Normal mode: share of depth", { positive: true }),
      minSpreadBps: bps(terms.normalMinSpreadPct, "Normal mode: minimum spread"),
      buybacksAllowed: yesNo(terms.normalBuybacks, "Normal mode"),
    };
    const defensive = {
      maxFillBase: amount(terms.defensiveMaxFill, base, "Defensive mode: largest fill"),
      maxFillDepthBps: bps(terms.defensiveDepthSharePct, "Defensive mode: share of depth", { positive: true }),
      minSpreadBps: bps(terms.defensiveMinSpreadPct, "Defensive mode: minimum spread"),
      buybacksAllowed: yesNo(terms.defensiveBuybacks, "Defensive mode"),
    };

    // Same rules as MandateModule._validatePolicy, phrased for the form.
    if (netSellCap > grossSellCap) throw new Error("Net sell limit: must not exceed the gross sell limit");
    if (shortWindow > twapWindow) throw new Error("Short TWAP window: must not be longer than the TWAP window");
    if (depthBandBps >= 10_000) throw new Error("Depth band: must be below 100%");
    if (defensiveMoveBps > pauseMoveBps) throw new Error("Defensive price move: must not exceed the pause threshold");
    if (defensiveVolatilityBps > pauseVolatilityBps) throw new Error("Defensive volatility: must not exceed the pause threshold");
    if (minTrustedDepth > defensiveDepth) throw new Error("Defensive depth: must be at least the minimum depth");
    if (normal.minSpreadBps >= 10_000 || defensive.minSpreadBps >= 10_000) throw new Error("Minimum spread: must be below 100%");
    if (defensive.maxFillBase > normal.maxFillBase) throw new Error("Defensive mode: largest fill must not exceed normal mode's");
    if (defensive.maxFillDepthBps > normal.maxFillDepthBps) throw new Error("Defensive mode: share of depth must not exceed normal mode's");
    if (defensive.minSpreadBps < normal.minSpreadBps) throw new Error("Defensive mode: minimum spread must be at least normal mode's");
    if (defensive.buybacksAllowed && !normal.buybacksAllowed) throw new Error("Defensive mode: cannot allow buybacks that normal mode forbids");

    const warnings: string[] = [];
    if (ctx.holdings?.base !== undefined && allotment > ctx.holdings.base)
      warnings.push(`The allotment exceeds the Safe's ${base.symbol} balance; strategies can only ship what the Safe holds.`);
    if (floorPriceX36 === 0n) warnings.push("No price floor: sells are limited only by the oracle checks and the caps.");
    if (minPoolAge === 0n) warnings.push("No minimum pool age: a brand-new pool can price trades once it has the TWAP window of history.");
    if (minTrustedDepth === 0n) warnings.push("No minimum depth: the treasury will trade against a pool of any size.");
    if (quoteSpendCap === 0n && (normal.buybacksAllowed || defensive.buybacksAllowed))
      warnings.push("Buybacks are allowed but the buyback budget is 0, so every buyback will be refused.");

    return {
      config: {
        release: { allotment, releaseStart, releaseDuration: whole(terms.releaseDays, "Release duration", "days", 86_400n, 2n ** 64n - 1n) },
        period: {
          periodLength: whole(terms.periodHours, "Period length", "hours", 3600n, 2n ** 64n - 1n),
          grossSellCap,
          netSellCap,
          quoteSpendCap,
        },
        price: {
          floorPriceX36,
          maxQuoteDeviationBps: bps(terms.quoteDeviationPct, "Quote tolerance"),
          maxImpactBps: bps(terms.impactPct, "Price impact allowance"),
        },
        oracle: {
          oracle: getAddress(ctx.oracle),
          twapWindow: Number(twapWindow),
          shortWindow: Number(shortWindow),
          depthBandBps,
          minPoolAge: Number(minPoolAge),
          minTrustedDepth,
          defensiveMoveBps,
          pauseMoveBps,
          defensiveVolatilityBps,
          pauseVolatilityBps,
          defensiveDepth,
        },
        normal,
        defensive,
      },
      warnings,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * The typed form of an existing policy, for editing it. These are the policy's current values (read from the chain
 * or the indexer), never defaults. Durations that are not whole units are rounded up so a re-save never loosens them.
 */
export function policyToTerms(config: PolicyConfigLike, base: TokenRef, quote: TokenRef): PolicyTerms {
  const n = (v: bigint | number | string) => BigInt(v);
  const amount = (v: bigint | number | string, t: TokenRef) => formatUnits(n(v), t.decimals, t.decimals).replaceAll(",", "");
  const pct = (v: bigint | number | string) => formatUnits(n(v), 2, 2).replaceAll(",", "");
  const units = (v: bigint | number | string, scale: bigint) => ((n(v) + scale - 1n) / scale).toString();
  const floor = n(config.price.floorPriceX36);
  return {
    allotment: amount(config.release.allotment, base),
    releaseStart: utcDate(n(config.release.releaseStart)),
    releaseDays: units(config.release.releaseDuration, 86_400n),
    periodHours: units(config.period.periodLength, 3600n),
    grossCap: amount(config.period.grossSellCap, base),
    netCap: amount(config.period.netSellCap, base),
    quoteSpendCap: amount(config.period.quoteSpendCap, quote),
    floor: floor === 0n ? "0" : x36ToPrice(floor, base, quote),
    quoteDeviationPct: pct(config.price.maxQuoteDeviationBps),
    impactPct: pct(config.price.maxImpactBps),
    twapMinutes: units(config.oracle.twapWindow, 60n),
    shortTwapMinutes: units(config.oracle.shortWindow, 60n),
    depthBandPct: pct(config.oracle.depthBandBps),
    minPoolAgeHours: units(config.oracle.minPoolAge, 3600n),
    minDepth: amount(config.oracle.minTrustedDepth, base),
    defensiveDepth: amount(config.oracle.defensiveDepth, base),
    defensiveMovePct: pct(config.oracle.defensiveMoveBps),
    pauseMovePct: pct(config.oracle.pauseMoveBps),
    defensiveVolatilityPct: pct(config.oracle.defensiveVolatilityBps),
    pauseVolatilityPct: pct(config.oracle.pauseVolatilityBps),
    normalMaxFill: amount(config.normal.maxFillBase, base),
    normalDepthSharePct: pct(config.normal.maxFillDepthBps),
    normalMinSpreadPct: pct(config.normal.minSpreadBps),
    normalBuybacks: config.normal.buybacksAllowed ? "yes" : "no",
    defensiveMaxFill: amount(config.defensive.maxFillBase, base),
    defensiveDepthSharePct: pct(config.defensive.maxFillDepthBps),
    defensiveMinSpreadPct: pct(config.defensive.minSpreadBps),
    defensiveBuybacks: config.defensive.buybacksAllowed ? "yes" : "no",
  };
}

type Num = bigint | number | string;
/** PolicyConfig as the chain (bigint) or the indexer (decimal strings) returns it. */
export interface PolicyConfigLike {
  release: { allotment: Num; releaseStart: Num; releaseDuration: Num };
  period: { periodLength: Num; grossSellCap: Num; netSellCap: Num; quoteSpendCap: Num };
  price: { floorPriceX36: Num; maxQuoteDeviationBps: Num; maxImpactBps: Num };
  oracle: {
    oracle: string; twapWindow: Num; shortWindow: Num; depthBandBps: Num; minPoolAge: Num; minTrustedDepth: Num;
    defensiveMoveBps: Num; pauseMoveBps: Num; defensiveVolatilityBps: Num; pauseVolatilityBps: Num; defensiveDepth: Num;
  };
  normal: { maxFillBase: Num; maxFillDepthBps: Num; minSpreadBps: Num; buybacksAllowed: boolean };
  defensive: { maxFillBase: Num; maxFillDepthBps: Num; minSpreadBps: Num; buybacksAllowed: boolean };
}

/** Exact decimal price (quote per base) of an X36 value, for prefilling; up to 18 decimals, no grouping. */
function x36ToPrice(x36: bigint, base: TokenRef, quote: TokenRef): string {
  const scaled = (x36 * 10n ** BigInt(base.decimals) * 10n ** 18n) / (10n ** 36n * 10n ** BigInt(quote.decimals));
  return formatUnits(scaled, 18, 18).replaceAll(",", "");
}

/**
 * Policies travel in the page URL so every co-owner opens the same link and builds the same Safe transaction.
 * Decoding is defensive: only known string fields are kept, and the owners still review every value.
 */
export function encodePolicy(terms: PolicyTerms): string {
  return JSON.stringify(Object.fromEntries(POLICY_KEYS.map((k) => [k, terms[k]])));
}

export function decodePolicy(value: string | null): Partial<PolicyTerms> | null {
  if (!value || value.length > 8192) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const out: Partial<PolicyTerms> = {};
    for (const key of POLICY_KEYS) {
      const v = (parsed as Record<string, unknown>)[key];
      if (typeof v === "string" && v.length <= 100) out[key] = v;
    }
    return out;
  } catch {
    return null;
  }
}

import type { PolicyTerms } from "./policy.ts";
import { parseUtcDate, type Holdings, type Terms, type TokenRef } from "./terms.ts";

/**
 * Plain-language read-outs for the policy and strategy forms: what each typed value will do, worked out against the
 * live pool and the Safe's balances where those are known. Display only. Numbers here are floating-point estimates
 * ("≈"); the exact values that get signed always come from `buildPolicy` / `buildTerms` and their review screens.
 * Pure (no React, no chain reads) so it is unit-tested; imports are relative so `node --test` can load it.
 */

/** The pool as the Launch page last read it. */
export interface MarketSnapshot {
  /** Pool price of base in quote, X36 (raw quote units per raw base unit × 1e36). */
  priceX36: bigint;
  /** In-range liquidity, all of it. */
  liquidity: bigint;
  /** In-range liquidity the hook trusts (settled); what the policy's depth checks use. */
  trustedLiquidity: bigint;
  /** Seconds since the pool was initialized, or null if it does not exist. */
  poolAgeSeconds: number | null;
  /** Seconds of price history the oracle holds. */
  historySeconds: number;
}

export interface Explanation {
  /** One sentence per field, keyed by the field it explains; missing when the value is empty or malformed. */
  fields: Partial<Record<string, string>>;
  /** The whole thing in a few sentences, in reading order. */
  summary: string[];
}

// ---------------------------------------------------------------------------------------------------------------
// Shared helpers

/** "1,000.5" → 1000.5; null when empty or not a plain non-negative decimal. */
export function num(value: string | undefined): number | null {
  const v = (value ?? "").trim().replaceAll(",", "");
  return /^\d+(\.\d+)?$/.test(v) ? Number(v) : null;
}

/** 12345.678 → "12,345.68"; tiny values keep significant digits. */
export function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "∞";
  const abs = Math.abs(n);
  const max = abs !== 0 && abs < 1 ? Math.max(digits, 4) : digits;
  return n.toLocaleString("en", { maximumFractionDigits: max });
}

const tokens = (raw: bigint | undefined, t: TokenRef) => (raw === undefined ? undefined : Number(raw) / 10 ** t.decimals);

/** Human price of one base token in quote tokens. */
export function priceOf(priceX36: bigint, base: TokenRef, quote: TokenRef): number {
  return (Number(priceX36) / 1e36) * 10 ** (base.decimals - quote.decimals);
}

/**
 * Base tokens needed to move the pool price by `bandPct` in either direction (the smaller side) against `liquidity`.
 * Mirrors UniswapV4MarketOracle._depth: it scales the pool's own sqrt price (currency1 per currency0) by
 * sqrt(1 ± band), so the result depends on which token is currency0 (the lower address).
 */
export function depthTokens(liquidity: bigint, priceX36: bigint, bandPct: number, base: TokenRef, quote: TokenRef): number {
  if (liquidity === 0n || priceX36 === 0n || bandPct <= 0 || bandPct >= 100) return 0;
  // Base reserve at the current price: L / sqrt(price of base in raw quote units), for either ordering.
  const reserve = Number(liquidity) / Math.sqrt(Number(priceX36) / 1e36);
  const up = Math.sqrt(1 + bandPct / 100);
  const down = Math.sqrt(1 - bandPct / 100);
  const baseIsCurrency0 = base.address.toLowerCase() < quote.address.toLowerCase();
  // currency0 base: amount0 between the scaled sqrt prices; currency1 base: amount1 (sqrt price moves inversely).
  const sides = baseIsCurrency0 ? [1 - 1 / up, 1 / down - 1] : [up - 1, 1 - down];
  return (reserve * Math.min(sides[0]!, sides[1]!)) / 10 ** base.decimals;
}

/** Rounds to two significant digits (12,345 → 12,000) so suggested values read as choices, not measurements. */
export function nice(n: number): number {
  if (!Number.isFinite(n) || n <= 0) return 0;
  const step = 10 ** Math.max(Math.floor(Math.log10(n)) - 1, 0);
  return Math.max(Math.floor(n / step) * step, 1);
}

const duration = (seconds: number) => {
  if (seconds < 60) return `${Math.max(Math.round(seconds), 0)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 172_800) return `${fmt(seconds / 3600, 1)} h`;
  return `${fmt(seconds / 86_400, 1)} days`;
};
const pctOf = (part: number, whole: number) => (whole > 0 ? `${fmt((part / whole) * 100, 1)}%` : "—");

// ---------------------------------------------------------------------------------------------------------------
// Suggested values

/**
 * A starting policy for a new treasury, sized from the pool and the Safe where they are known (else the demo
 * values below): depth thresholds and fill sizes follow the pool's depth, the floor sits 25% under today's price,
 * the allotment is a tenth of the Safe's tokens. Every value stays editable; nothing is signed until review.
 */
export function suggestPolicy(ctx: { base: TokenRef; quote: TokenRef; market?: MarketSnapshot; holdings?: Holdings; now?: Date }): PolicyTerms {
  const now = ctx.now ?? new Date();
  const price = ctx.market && ctx.market.priceX36 > 0n ? priceOf(ctx.market.priceX36, ctx.base, ctx.quote) : null;
  // Liquidity still settling counts here: the suggestion is for once it has settled.
  const depth = ctx.market ? depthTokens(ctx.market.liquidity, ctx.market.priceX36, 5, ctx.base, ctx.quote) : 0;
  const held = tokens(ctx.holdings?.base, ctx.base);
  const allotment = held ? nice(held / 10) : 1_000_000;
  const grossCap = nice(allotment / 10);
  const minDepth = depth > 0 ? nice(depth * 0.5) : 5_000;
  const defensiveDepth = depth > 0 ? Math.max(nice(depth * 0.8), minDepth) : 8_000;
  const normalMaxFill = depth > 0 ? Math.max(nice(depth * 0.1), 1) : 1_000;
  const start = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
  return {
    allotment: String(allotment), releaseStart: start, releaseDays: "180",
    periodHours: "24", grossCap: String(grossCap), netCap: String(nice(grossCap / 2)),
    quoteSpendCap: String(price ? nice(grossCap * price * 0.2) : 20_000),
    floor: price ? String(Number((price * 0.75).toPrecision(3))) : "0", quoteDeviationPct: "3", impactPct: "3",
    twapMinutes: "1", shortTwapMinutes: "1", depthBandPct: "5", minPoolAgeHours: "0",
    minDepth: String(minDepth), defensiveDepth: String(defensiveDepth),
    defensiveMovePct: "2", pauseMovePct: "10", defensiveVolatilityPct: "3", pauseVolatilityPct: "15",
    normalMaxFill: String(normalMaxFill), normalDepthSharePct: "20", normalMinSpreadPct: "0", normalBuybacks: "yes",
    defensiveMaxFill: String(Math.max(nice(normalMaxFill / 2), 1)), defensiveDepthSharePct: "10", defensiveMinSpreadPct: "1.5", defensiveBuybacks: "no",
  };
}

/**
 * A starting market-making strategy: a quarter of what the Safe can back in tokens (at most 250,000), matched in
 * quote at the pool price so trading starts at the market (blank without a pool price); inventory ceilings at half
 * of what the Safe can back.
 */
export function suggestTerms(ctx: { base: TokenRef; quote: TokenRef; mm?: string; anchorPriceX36?: bigint; holdings?: Holdings }): Terms {
  // Without a pool price there is nothing to match the quote side to: it is left for the issuer.
  const price = ctx.anchorPriceX36 ? priceOf(ctx.anchorPriceX36, ctx.base, ctx.quote) : null;
  const heldBase = tokens(ctx.holdings?.base, ctx.base);
  const heldQuote = tokens(ctx.holdings?.quote, ctx.quote);
  let shippedBase = nice(Math.min(250_000, heldBase !== undefined ? heldBase / 4 : 250_000));
  let shippedQuote = price !== null ? shippedBase * price : null;
  if (price !== null && shippedQuote !== null && heldQuote !== undefined && shippedQuote > heldQuote / 2) {
    shippedQuote = heldQuote / 2;
    shippedBase = shippedQuote / price;
  }
  const quoteText = shippedQuote !== null ? Number(shippedQuote.toFixed(Math.min(ctx.quote.decimals, 6))).toString() : "";
  return {
    mm: ctx.mm ?? "", kind: "marketMaking", spreadMinPct: "0.1", spreadMaxPct: "2", feeSharePct: "50",
    maxShippedBase: String(heldBase !== undefined ? nice(heldBase / 2) : 1_000_000),
    maxShippedQuote: String(heldQuote !== undefined ? nice(heldQuote / 2) : 400_000),
    maxBuyPrice: "", spreadPct: "0.8",
    shippedBase: Number(shippedBase.toFixed(Math.min(ctx.base.decimals, 6))).toString(), shippedQuote: quoteText,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Policy

export function explainPolicy(terms: PolicyTerms, ctx: { base: TokenRef; quote: TokenRef; market?: MarketSnapshot; holdings?: Holdings; now?: Date }): Explanation {
  const B = ctx.base.symbol;
  const Q = ctx.quote.symbol;
  const f: Explanation["fields"] = {};
  const now = (ctx.now ?? new Date()).getTime() / 1000;
  const m = ctx.market;
  const price = m && m.priceX36 > 0n ? priceOf(m.priceX36, ctx.base, ctx.quote) : null;
  const held = tokens(ctx.holdings?.base, ctx.base);

  const allotment = num(terms.allotment);
  const days = num(terms.releaseDays);
  const start = parseUtcDate(terms.releaseStart);
  const hours = num(terms.periodHours);
  const gross = num(terms.grossCap);
  const net = num(terms.netCap);
  const spend = num(terms.quoteSpendCap);
  const floor = num(terms.floor);
  const dev = num(terms.quoteDeviationPct);
  const impact = num(terms.impactPct);
  const twap = num(terms.twapMinutes);
  const short = num(terms.shortTwapMinutes);
  const band = num(terms.depthBandPct);
  const age = num(terms.minPoolAgeHours);
  const minDepth = num(terms.minDepth);
  const defDepth = num(terms.defensiveDepth);
  const trusted = m && band ? depthTokens(m.trustedLiquidity, m.priceX36, band, ctx.base, ctx.quote) : null;
  const total = m && band ? depthTokens(m.liquidity, m.priceX36, band, ctx.base, ctx.quote) : null;

  // Release
  let unlocked: number | null = null;
  if (allotment !== null) {
    f.allotment = `The most the treasury may ever sell, net of buybacks: ${fmt(allotment)} ${B}` +
      (held !== undefined ? (allotment > held ? `, more than the Safe's ${fmt(held)} ${B}, so the Safe's balance is the real limit.` : ` (${pctOf(allotment, held)} of the Safe's ${fmt(held)} ${B}).`) : ".");
  }
  if (allotment !== null && days && start !== null) {
    const elapsed = now - Number(start);
    unlocked = Math.min(Math.max(elapsed / (days * 86_400), 0), 1) * allotment;
    f.releaseStart = elapsed >= 0
      ? `Started ${duration(elapsed)} ago, so ≈${fmt(unlocked, 0)} ${B} has already unlocked and can be sold today.`
      : `Nothing can be sold until it starts, ${duration(-elapsed)} from now.`;
    f.releaseDays = `≈${fmt(allotment / days, 0)} ${B} unlock per day (≈${fmt(allotment / days / 24, 0)} per hour); all of it by ${new Date((Number(start) + days * 86_400) * 1000).toISOString().slice(0, 10)}.`;
  }

  // Period limits
  if (hours) f.periodHours = `The sell limits and the buyback budget refill every ${fmt(hours)} hours, counted from the release start.`;
  if (gross !== null && hours) {
    f.grossCap = `All strategies together sell at most ${fmt(gross)} ${B} per ${fmt(hours)} h, even if they buy it back later` +
      (price ? ` (≈${fmt(gross * price)} ${Q} at today's price).` : ".");
  }
  if (net !== null) {
    f.netCap = gross !== null && net > gross
      ? `Higher than the gross limit, which is not allowed: lower it to ${fmt(gross)} or less.`
      : `Sales minus buybacks stay under ${fmt(net)} ${B} per period, so a strategy can sell, buy back and sell again within the gross limit.`;
  }
  if (spend !== null) {
    f.quoteSpendCap = spend === 0
      ? "Every buyback will be refused: the treasury only sells."
      : `Buybacks may spend up to ${fmt(spend)} ${Q} per period` + (price ? ` (≈${fmt(spend / price, 0)} ${B} at today's price).` : ".");
  }

  // Price rules
  if (floor !== null) {
    f.floor = floor === 0
      ? "No floor: sales are limited only by the market checks and the caps."
      : price
        ? floor >= price
          ? `Above today's price of ${fmt(price)}: every sale is refused until the price rises past ${fmt(floor)} ${Q}.`
          : `Never sells below ${fmt(floor)} ${Q}, ${pctOf(price - floor, price)} under today's ${fmt(price)}.`
        : `Never sells below ${fmt(floor)} ${Q} per ${B}.`;
  }
  if (dev !== null) {
    f.quoteDeviationPct = `A strategy's price must sit within ${fmt(dev)}% of the TWAP, or the trade is refused (no stale quotes)` +
      (price ? `: today ${fmt(price * (1 - dev / 100))}–${fmt(price * (1 + dev / 100))} ${Q}.` : ".");
  }
  if (impact !== null) f.impactPct = `One fill may move the price by at most ${fmt(impact)}% on top of the spread; bigger fills are refused.`;

  // Market reading
  if (twap) {
    const need = twap * 60;
    f.twapMinutes = `The reference price is the average of the last ${fmt(twap)} min.` +
      (m ? (m.historySeconds >= need ? " The pool already has enough history." : ` The pool has ${duration(m.historySeconds)} of history: priced in ≈${duration(need - m.historySeconds)}.`) : "");
  }
  if (short && twap) {
    f.shortTwapMinutes = short > twap
      ? "Longer than the TWAP window, which is not allowed."
      : short === twap
        ? "Same as the TWAP window: volatility always reads 0, so only price moves and depth change the mode."
        : `Volatility = the gap between the ${fmt(short)}-min and ${fmt(twap)}-min averages.`;
  }
  if (band) {
    f.depthBandPct = `Depth = ${B} it takes to move the price ${fmt(band)}%.` +
      (trusted !== null && total !== null ? ` This pool: ≈${fmt(trusted, 0)} ${B} trusted now${total > trusted + 1 ? `, ≈${fmt(total, 0)} once new liquidity settles` : ""}.` : "");
  }
  if (age !== null) {
    f.minPoolAgeHours = age === 0
      ? "No age check: a new pool trades as soon as it has the TWAP history and enough depth."
      : `A pool younger than ${fmt(age)} h pauses trading.` + (m?.poolAgeSeconds != null ? (m.poolAgeSeconds >= age * 3600 ? " This pool is old enough." : ` This pool is ${duration(m.poolAgeSeconds)} old: ready in ≈${duration(age * 3600 - m.poolAgeSeconds)}.`) : "");
  }
  if (minDepth !== null) {
    f.minDepth = minDepth === 0
      ? "No minimum: the treasury trades against a pool of any size."
      : `Under ${fmt(minDepth)} ${B} of trusted depth, trading pauses.` + (trusted !== null ? (trusted >= minDepth ? ` This pool passes (≈${fmt(trusted, 0)}).` : ` This pool has ≈${fmt(trusted, 0)} trusted: it would pause${total !== null && total >= minDepth ? " until its liquidity settles" : ""}.`) : "");
  }
  if (defDepth !== null) {
    f.defensiveDepth = minDepth !== null && defDepth < minDepth
      ? "Below the minimum depth, which is not allowed."
      : `Under ${fmt(defDepth)} ${B}, trading switches to defensive limits.` + (trusted !== null && trusted >= (minDepth ?? 0) ? (trusted >= defDepth ? " This pool reads normal." : " This pool would read defensive.") : "");
  }

  // Risk thresholds
  const move = (key: "defensiveMovePct" | "pauseMovePct", what: string) => {
    const v = num(terms[key]);
    if (v !== null) f[key] = `If spot moves ${fmt(v)}% away from the TWAP, ${what}` + (price ? `: under ${fmt(price * (1 - v / 100))} or over ${fmt(price * (1 + v / 100))} ${Q} today.` : ".");
  };
  move("defensiveMovePct", "limits turn defensive");
  move("pauseMovePct", "trading pauses");
  const vol = (key: "defensiveVolatilityPct" | "pauseVolatilityPct", what: string) => {
    const v = num(terms[key]);
    if (v !== null) f[key] = `If the short and long averages differ by ${fmt(v)}% or more, ${what}.`;
  };
  vol("defensiveVolatilityPct", "limits turn defensive");
  vol("pauseVolatilityPct", "trading pauses");

  // Mode limits
  const mode = (prefix: "normal" | "defensive", name: string) => {
    const fill = num(terms[`${prefix}MaxFill`]);
    const share = num(terms[`${prefix}DepthSharePct`]);
    const spread = num(terms[`${prefix}MinSpreadPct`]);
    const buy = terms[`${prefix}Buybacks`];
    if (fill !== null) {
      const cap = share !== null && trusted !== null ? Math.min(fill, (trusted * share) / 100) : null;
      f[`${prefix}MaxFill`] = `In ${name} mode one fill is at most ${fmt(fill)} ${B}` +
        (cap !== null ? `; with this pool's depth the real cap is ≈${fmt(cap, 0)} ${B}${cap === 0 ? " (no trusted depth yet)" : ""}.` : ".");
    }
    if (share !== null) f[`${prefix}DepthSharePct`] = `One fill takes at most ${fmt(share)}% of the trusted depth` + (trusted !== null ? ` (≈${fmt((trusted * share) / 100, 0)} ${B} now).` : ".");
    if (spread !== null) f[`${prefix}MinSpreadPct`] = spread === 0 ? "The strategy's own spread applies." : `Strategies quote at least ${fmt(spread)}% in ${name} mode, even if they set less.`;
    if (buy === "yes" || buy === "no") f[`${prefix}Buybacks`] = buy === "yes" ? `The treasury may buy back in ${name} mode, within the buyback budget.` : `No buybacks in ${name} mode: it only sells.`;
  };
  mode("normal", "normal");
  mode("defensive", "defensive");

  // Summary
  const summary: string[] = [];
  if (gross !== null && hours) summary.push(`Sells at most ${fmt(gross)} ${B} every ${fmt(hours)} h${net !== null ? ` (${fmt(net)} net of buybacks)` : ""}${floor ? `, never below ${fmt(floor)} ${Q}` : ""}.`);
  if (allotment !== null && days) summary.push(`Releases ${fmt(allotment)} ${B} over ${fmt(days)} days${unlocked !== null ? `; ≈${fmt(unlocked, 0)} is unlocked today` : ""}.`);
  if (spend !== null) summary.push(spend === 0 || terms.normalBuybacks === "no" ? "Buybacks are off." : `Buys back with up to ${fmt(spend)} ${Q} per period${terms.defensiveBuybacks === "no" ? ", but not in defensive mode" : ""}.`);
  const pause = num(terms.pauseMovePct);
  if (minDepth !== null && twap) summary.push(`Pauses when the price has under ${fmt(twap)} min of history${age ? `, the pool is under ${fmt(age)} h old` : ""}, depth is under ${fmt(minDepth)} ${B}${pause !== null ? `, or the price moves ${fmt(pause)}%` : ""}.`);
  if (m && twap && minDepth !== null && trusted !== null) {
    const reasons: string[] = [];
    if (m.historySeconds < twap * 60) reasons.push(`price history (${duration(twap * 60 - m.historySeconds)} to go)`);
    if (age && m.poolAgeSeconds !== null && m.poolAgeSeconds < age * 3600) reasons.push(`pool age (${duration(age * 3600 - m.poolAgeSeconds)} to go)`);
    if (trusted < minDepth) reasons.push(total !== null && total >= minDepth ? "liquidity still settling (up to 10 min)" : "depth below the minimum");
    summary.push(reasons.length
      ? `On this pool right now it would be paused, waiting for ${reasons.join(", ")}.`
      : `On this pool right now it would trade in ${defDepth !== null && trusted < defDepth ? "defensive" : "normal"} mode (price moves and volatility permitting).`);
  }
  return { fields: f, summary };
}

// ---------------------------------------------------------------------------------------------------------------
// Strategy

/** The policy values a strategy is explained against. */
export interface PolicyLimits {
  normalMinSpreadBps: number;
  grossSellCapBase: bigint;
  periodSeconds: number;
}

export function explainTerms(terms: Terms, ctx: { base: TokenRef; quote: TokenRef; anchorPriceX36?: bigint; holdings?: Holdings; limits?: PolicyLimits }): Explanation {
  const B = ctx.base.symbol;
  const Q = ctx.quote.symbol;
  const f: Explanation["fields"] = {};
  const pool = ctx.anchorPriceX36 ? priceOf(ctx.anchorPriceX36, ctx.base, ctx.quote) : null;
  const heldBase = tokens(ctx.holdings?.base, ctx.base);
  const heldQuote = tokens(ctx.holdings?.quote, ctx.quote);
  const buyback = terms.kind === "buyback";

  const min = num(terms.spreadMinPct);
  const max = num(terms.spreadMaxPct);
  const fee = num(terms.feeSharePct);
  const maxB = num(terms.maxShippedBase);
  const maxQ = num(terms.maxShippedQuote);
  const spread = num(terms.spreadPct);
  const sb = num(terms.shippedBase);
  const sq = num(terms.shippedQuote);
  const start = sb && sq !== null ? sq / sb : null;
  const policyMin = ctx.limits ? ctx.limits.normalMinSpreadBps / 100 : null;

  if (/^0x[0-9a-fA-F]{40}$/.test(terms.mm.trim())) f.mm = `Only ${terms.mm.trim().slice(0, 6)}…${terms.mm.trim().slice(-4)} can retune the spread, reship inventory, pause and claim fees. It never holds the Safe's tokens.`;
  if (min !== null) f.spreadMinPct = `The market maker can never quote tighter than ${fmt(min)}%` + (policyMin !== null && policyMin > min ? `; the policy lifts that to ${fmt(policyMin)}% in normal mode.` : ".");
  if (max !== null) f.spreadMaxPct = min !== null && max < min ? "Below the minimum spread, which is not allowed." : `…and never wider than ${fmt(max)}%, so takers always get a fair quote.`;
  if (fee !== null) f.feeSharePct = fee > 100 ? "Above 100%, which is not allowed." : `Of every spread fee, ${fmt(fee)}% goes to the market maker and ${fmt(100 - fee)}% stays with the treasury. Fixed once added.`;
  if (maxB !== null) f.maxShippedBase = `Reships can never put more than ${fmt(maxB)} ${B} into the order` + (heldBase !== undefined ? ` (${pctOf(maxB, heldBase)} of what the Safe can back).` : ".");
  if (maxQ !== null) f.maxShippedQuote = `…or more than ${fmt(maxQ)} ${Q}` + (heldQuote !== undefined ? ` (${pctOf(maxQ, heldQuote)} of what the Safe can back).` : ".");
  if (spread !== null) {
    const out = (min !== null && spread < min) || (max !== null && spread > max);
    f.spreadPct = out
      ? "Outside the market maker's spread range above."
      : `Starting spread ${fmt(spread)}%` + (start ? `: takers buy at ≈${fmt(start * (1 + spread / 100))} and sell to the treasury at ≈${fmt(start * (1 - spread / 100))} ${Q}, before price impact.` : ".") +
        (policyMin !== null && policyMin > spread ? ` The policy raises it to ${fmt(policyMin)}%.` : "");
  }
  if (sb !== null) {
    f.shippedBase = (buyback ? "Tokens a buyback order holds; usually 0." : `${fmt(sb)} ${B} for takers to buy`) +
      (heldBase !== undefined ? (sb > heldBase ? ` More than the Safe can back (${fmt(heldBase)}): the add will be refused.` : ` (${pctOf(sb, heldBase)} of what the Safe can back).`) : ".") +
      (ctx.limits ? ` The policy still caps sales at ${fmt(Number(ctx.limits.grossSellCapBase) / 10 ** ctx.base.decimals)} ${B} per period.` : "");
  }
  if (sq !== null) {
    f.shippedQuote = `${fmt(sq)} ${Q} for buybacks` +
      (heldQuote !== undefined ? (sq > heldQuote ? `. More than the Safe can back (${fmt(heldQuote)}): the add will be refused.` : ` (${pctOf(sq, heldQuote)} of what the Safe can back).`) : ".") +
      (start && pool ? ` Starting price ${fmt(start)} ${Q}, ${Math.abs(start / pool - 1) < 0.0005 ? "the same as the pool" : `${fmt(Math.abs(start / pool - 1) * 100, 2)}% ${start > pool ? "above" : "below"} the pool's ${fmt(pool)}`}.` : "");
  }
  const maxBuy = num(terms.maxBuyPrice);
  if (buyback && maxBuy !== null) f.maxBuyPrice = `The treasury never pays more than ${fmt(maxBuy)} ${Q}` + (pool ? ` (${maxBuy >= pool ? "above" : `${pctOf(pool - maxBuy, pool)} under`} today's ${fmt(pool)}).` : ".");

  const summary: string[] = [];
  if (sb !== null && sq !== null) summary.push(buyback
    ? `A buyback order holding ${fmt(sq)} ${Q}${maxBuy !== null ? `, paying at most ${fmt(maxBuy)} ${Q} per ${B}` : ""}.`
    : `A market-making order holding ${fmt(sb)} ${B} and ${fmt(sq)} ${Q}${start ? `, starting at ${fmt(start)} ${Q} per ${B}` : ""}.`);
  if (spread !== null && min !== null && max !== null) summary.push(`Spread ${fmt(spread)}% to start; the market maker may move it between ${fmt(min)}% and ${fmt(max)}%.`);
  if (fee !== null) summary.push(`The market maker keeps ${fmt(fee)}% of spread fees; the rest stays in the Safe.`);
  if (maxB !== null && maxQ !== null) summary.push(`Reships can grow the order to ${fmt(maxB)} ${B} and ${fmt(maxQ)} ${Q}, and never past what the Safe holds.`);
  summary.push("Every fill still passes the treasury policy: its caps, floor and risk mode.");
  return { fields: f, summary };
}

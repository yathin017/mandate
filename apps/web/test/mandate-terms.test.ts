import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Address } from "viem";

import { buildTerms, decodeTerms, encodeTerms, parseUtcDate, priceToX36, STANDARD_RAILS, utcDate, type Terms, type TokenRef } from "../src/issuer/terms.ts";

/** Pure conversion of typed mandate terms into createMandate arguments; no chain needed. */
const SAFE = "0x80fecadebf0d28791ff07a2195a4eab82ad46fc7" as Address;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const MM = "0xbDafcA30260a4a5550cAD1F11928b26f1B063126" as Address;
const ANCHOR = "0x9B78f6553A921D1bea0722CAd111CDAE4299522B" as Address;
const BASE: TokenRef = { address: "0xf53280706fdc2f0f82e1c3bceb61fd8d6b58104e", symbol: "dLAUNCH", decimals: 18 };
const QUOTE: TokenRef = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };

const TERMS: Terms = {
  ...STANDARD_RAILS,
  mm: MM.toLowerCase(),
  allotment: "1000000",
  releaseStart: "2026-11-06",
  dailyCap: "50000",
  floor: "0.30",
  shippedBase: "250000",
  shippedQuote: "100000",
};
const ctx = { safe: SAFE, owners: [OWNER], base: BASE, quote: QUOTE, anchor: ANCHOR, holdings: { base: 10n ** 24n, quote: 200_000n * 10n ** 6n }, anchorPriceX36: priceToX36("0.40", BASE, QUOTE)! };
const error = (overrides: Partial<Terms>, c = ctx) => {
  const built = buildTerms({ ...TERMS, ...overrides }, c);
  return "error" in built ? built.error : undefined;
};

describe("mandate terms", () => {
  test("dates are absolute UTC days and impossible dates are refused", () => {
    assert.equal(parseUtcDate("2026-11-06"), 1_793_923_200n);
    assert.equal(utcDate(1_793_923_200n + 86_399n), "2026-11-06");
    assert.equal(parseUtcDate("2026-02-31"), null);
    assert.equal(parseUtcDate("6 Nov 2026"), null);
  });

  test("prices convert to quoteRaw * 1e36 / baseRaw", () => {
    // 0.30 USDC (300000 raw) per 1e18 raw base.
    assert.equal(priceToX36("0.30", BASE, QUOTE), (300_000n * 10n ** 36n) / 10n ** 18n);
    assert.equal(priceToX36("abc", BASE, QUOTE), null);
  });

  test("valid terms build the createMandate bounds and params", () => {
    const built = buildTerms(TERMS, ctx);
    assert.ok(!("error" in built), "error" in built ? built.error : "");
    assert.equal(built.marketMaker, MM);
    assert.equal(built.bounds.releaseStart, 1_793_923_200n);
    assert.equal(built.bounds.releaseDuration, 180n * 86_400n);
    assert.equal(built.bounds.anchor, ANCHOR);
    assert.equal(built.bounds.twapWindow, 1800);
    assert.equal(built.bounds.maxAnchorDeviationBps, 300);
    assert.deepEqual([built.bounds.spreadBpsMin, built.bounds.spreadBpsMax, built.params.spreadBps], [10, 200, 80]);
    assert.equal(built.params.shippedBase, 250_000n * 10n ** 18n);
    assert.equal(built.params.shippedQuote, 100_000n * 10n ** 6n);
    assert.equal(built.bounds.maxShippedQuote, built.params.shippedQuote);
    assert.deepEqual(built.warnings, []);
  });

  test("module rules and Safe balances are explained before approval", () => {
    assert.match(error({ mm: SAFE })!, /cannot be the Safe/);
    assert.match(error({ mm: "0x123" })!, /not a valid address/);
    assert.match(error({ spreadMaxPct: "3" })!, /below the anchor tolerance/);
    assert.match(error({ spreadPct: "2.5", spreadMaxPct: "2" })!, /within the spread range/);
    assert.match(error({ shippedBase: "2000000" })!, /exceed the allotment/);
    assert.match(error({ shippedQuote: "200000.000001" })!, /holds only 200000 USDC/);
    assert.match(error({ shippedQuote: "1.0000001" })!, /at most 6 decimals/);
    assert.match(error({ releaseDays: "0" })!, /at least 1/);
    assert.match(error({}, { ...ctx, holdings: { base: 10n ** 18n, quote: 10n ** 12n } })!, /holds only 1 dLAUNCH/);
  });

  test("the shipped ratio is the starting price: it must sit inside the anchor band and above the floor", () => {
    // 250,000 base against 1,000 quote starts at 0.004, under the 0.30 floor.
    assert.match(error({ shippedQuote: "1000" })!, /0\.004 USDC per dLAUNCH is below the floor.*ship about 100000 USDC/);
    // 0.36 is 10% under the 0.40 pool price, outside the 3% band.
    assert.match(error({ shippedQuote: "90000" })!, /outside the anchor tolerance of the pool price 0\.4 USDC/);
    // 0.392 is 2% under: inside the band.
    assert.equal(error({ shippedQuote: "98000" }), undefined);
    // Without a pool price only the floor is checked.
    const { anchorPriceX36: _, ...withoutPool } = ctx;
    assert.equal(error({ shippedQuote: "90000" }, withoutPool as typeof ctx), undefined);
  });

  test("an owner as market maker and an under-funded allotment are warned, not refused", () => {
    const built = buildTerms({ ...TERMS, mm: OWNER }, { ...ctx, holdings: { base: 300_000n * 10n ** 18n, quote: 10n ** 12n } });
    assert.ok(!("error" in built));
    assert.equal(built.warnings.length, 2);
  });

  test("shared links keep only known string fields", () => {
    assert.deepEqual(decodeTerms(encodeTerms(TERMS)), TERMS);
    assert.deepEqual(decodeTerms('{"mm":"0x1","floor":5,"evil":"x"}'), { mm: "0x1" });
    assert.equal(decodeTerms("[1,2]"), null);
    assert.equal(decodeTerms("not json"), null);
    assert.equal(decodeTerms("x".repeat(5000)), null);
  });
});

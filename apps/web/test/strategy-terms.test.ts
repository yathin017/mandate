import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Address } from "viem";

import { buildTerms, decodeTerms, EMPTY_TERMS, encodeTerms, parseUtcDate, priceToX36, utcDate, type Terms, type TokenRef } from "../src/issuer/terms.ts";

/** Pure conversion of typed strategy terms into addStrategy arguments; no chain needed. Values are test inputs. */
const SAFE = "0x80fecadebf0d28791ff07a2195a4eab82ad46fc7" as Address;
const OWNER = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const MM = "0xbDafcA30260a4a5550cAD1F11928b26f1B063126" as Address;
const BASE: TokenRef = { address: "0xf53280706fdc2f0f82e1c3bceb61fd8d6b58104e", symbol: "dLAUNCH", decimals: 18 };
const QUOTE: TokenRef = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };

const TERMS: Terms = {
  mm: MM.toLowerCase(),
  kind: "marketMaking",
  spreadMinPct: "0.1",
  spreadMaxPct: "2",
  feeSharePct: "50",
  maxShippedBase: "1000000",
  maxShippedQuote: "200000",
  maxBuyPrice: "",
  spreadPct: "0.8",
  shippedBase: "250000",
  shippedQuote: "100000",
};
const policy = { floorPriceX36: priceToX36("0.30", BASE, QUOTE)!, maxQuoteDeviationBps: 300 };
const ctx = {
  safe: SAFE, owners: [OWNER], base: BASE, quote: QUOTE,
  holdings: { base: 10n ** 24n, quote: 200_000n * 10n ** 6n },
  anchorPriceX36: priceToX36("0.40", BASE, QUOTE)!, policy,
};
const error = (overrides: Partial<Terms>, c: Parameters<typeof buildTerms>[1] = ctx) => {
  const built = buildTerms({ ...TERMS, ...overrides }, c);
  return "error" in built ? built.error : undefined;
};

describe("strategy terms", () => {
  test("dates are absolute UTC days and impossible dates are refused", () => {
    assert.equal(parseUtcDate("2026-11-06"), 1_793_923_200n);
    assert.equal(utcDate(1_793_923_200n + 86_399n), "2026-11-06");
    assert.equal(parseUtcDate("2026-02-31"), null);
    assert.equal(parseUtcDate("6 Nov 2026"), null);
  });

  test("prices convert to quoteRaw * 1e36 / baseRaw", () => {
    assert.equal(priceToX36("0.40", BASE, QUOTE), 4n * 10n ** 23n);
    assert.equal(priceToX36("abc", BASE, QUOTE), null);
  });

  test("valid terms become exact bounds and params", () => {
    const built = buildTerms(TERMS, ctx);
    assert.ok(!("error" in built), "error" in built ? built.error : "");
    assert.equal(built.marketMaker, MM);
    assert.equal(built.kind, 0);
    assert.deepEqual(built.bounds, {
      spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 10n ** 24n, maxShippedQuote: 200_000n * 10n ** 6n,
      mmFeeShareBps: 5000, maxBuyPriceX36: 0n,
    });
    assert.deepEqual(built.params, { spreadBps: 80, shippedBase: 250_000n * 10n ** 18n, shippedQuote: 100_000n * 10n ** 6n });
    assert.deepEqual(built.warnings, []);
  });

  test("nothing is assumed: empty terms are refused field by field", () => {
    assert.match(error({ ...EMPTY_TERMS, mm: TERMS.mm }) ?? "", /Strategy kind/);
    assert.match(error({ spreadMinPct: "" }) ?? "", /Minimum spread/);
    assert.match(error({ feeSharePct: "" }) ?? "", /fee share/);
  });

  test("the module's bound rules are explained before anyone signs", () => {
    assert.match(error({ mm: "0x123" })!, /not a valid address/);
    assert.match(error({ mm: SAFE })!, /cannot be the Safe/);
    assert.match(error({ spreadMinPct: "3" })!, /must not exceed the maximum spread/);
    assert.match(error({ spreadMaxPct: "100" })!, /below 100%/);
    assert.match(error({ spreadPct: "5" })!, /within the spread range/);
    assert.match(error({ shippedBase: "2000000" })!, /most token inventory/);
    assert.match(error({ shippedQuote: "300000" })!, /most quote inventory/);
    assert.match(error({ shippedBase: "250000.0000000000000000001" })!, /at most 18 decimals/);
  });

  test("backing: the Safe can only ship what its other strategies have not committed", () => {
    const tight = { ...ctx, holdings: { base: 200_000n * 10n ** 18n, quote: 10n ** 12n } };
    assert.match(error({}, tight)!, /can back only 200000 dLAUNCH/);
  });

  test("the starting price must sit inside the policy's floor and quote tolerance", () => {
    // 250k for 50k quote = 0.20, below the 0.30 floor.
    assert.match(error({ shippedQuote: "50000" })!, /below the policy's floor/);
    // 0.45 is 12.5% off the 0.40 pool, beyond the 3% tolerance.
    assert.match(error({ shippedQuote: "112500" })!, /outside the policy's quote tolerance.*about 100000 USDC/);
    // Without a policy (e.g. not created yet) only the contract's own rules apply.
    const { policy: _policy, ...noPolicy } = ctx;
    assert.equal(error({ shippedQuote: "112500" }, noPolicy), undefined);
  });

  test("buyback strategies need their highest price and never check the floor", () => {
    assert.match(error({ kind: "buyback" })!, /Highest buyback price/);
    const built = buildTerms({ ...TERMS, kind: "buyback", maxBuyPrice: "0.38", shippedQuote: "100000" }, ctx);
    assert.ok(!("error" in built));
    assert.equal(built.kind, 1);
    assert.equal(built.bounds.maxBuyPriceX36, 38n * 10n ** 22n);
    assert.match(built.warnings.join(" "), /never sells/);
  });

  test("an owner acting as market maker is flagged, not refused", () => {
    const built = buildTerms({ ...TERMS, mm: OWNER }, ctx);
    assert.ok(!("error" in built));
    assert.match(built.warnings[0]!, /not separated/);
  });

  test("terms survive the shareable link and junk is dropped", () => {
    assert.deepEqual(decodeTerms(encodeTerms(TERMS)), TERMS);
    assert.deepEqual(decodeTerms(JSON.stringify({ mm: MM, evil: "x", spreadPct: 5 })), { mm: MM });
    assert.equal(decodeTerms("not json"), null);
    assert.equal(decodeTerms("x".repeat(5000)), null);
  });
});

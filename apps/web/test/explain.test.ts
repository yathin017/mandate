import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { depthTokens, explainPolicy, explainTerms, nice, suggestPolicy, suggestTerms, type MarketSnapshot } from "../src/issuer/explain.ts";
import { buildPolicy } from "../src/issuer/policy.ts";
import type { TokenRef } from "../src/issuer/terms.ts";

const BASE: TokenRef = { address: "0xC593D152c38446EB88Bb2FF3D05b6464De32C914", symbol: "EGM", decimals: 18 };
const QUOTE: TokenRef = { address: "0x2D718b826aB88023b693D1bd8531D83054d7e877", symbol: "dUSD", decimals: 6 };
const ORACLE = "0x2376eD3BDC8eA7faC0EBeFb978855878aC6A692D";
// 0.40 dUSD per EGM in raw units × 1e36, and the demo pool's liquidity (1e18 full range ≈ 39,046 EGM of 5% depth).
const PRICE_X36 = (4n * 10n ** 35n * 10n ** 6n) / 10n ** 18n;
const MARKET: MarketSnapshot = { priceX36: PRICE_X36, liquidity: 10n ** 18n, trustedLiquidity: 10n ** 18n, poolAgeSeconds: 3600, historySeconds: 3600 };
const NOW = new Date("2026-11-07T08:00:00Z");
const HOLDINGS = { base: 9_600_000n * 10n ** 18n, quote: 840_000n * 10n ** 6n };

describe("form explanations", () => {
  test("depth matches the oracle's reading of the live demo pool", () => {
    const depth = depthTokens(10n ** 18n, PRICE_X36, 5, BASE, QUOTE);
    assert.ok(Math.abs(depth - 39_046) < 50, `depth ${depth}`);
    assert.equal(depthTokens(0n, PRICE_X36, 5, BASE, QUOTE), 0);
  });

  test("depth follows the pool's token order, like the oracle", () => {
    const low = { ...BASE, address: "0x0000000000000000000000000000000000000001" as const };
    const asCurrency0 = depthTokens(10n ** 18n, PRICE_X36, 5, low, QUOTE);
    assert.ok(Math.abs(asCurrency0 - 38_105) < 50, `depth ${asCurrency0}`);
  });

  test("nice keeps two significant digits", () => {
    assert.equal(nice(39_046), 39_000);
    assert.equal(nice(960_000), 960_000);
    assert.equal(nice(0.4), 1);
  });

  test("suggested policy is sized to the pool and the Safe, and is valid", () => {
    const terms = suggestPolicy({ base: BASE, quote: QUOTE, market: MARKET, holdings: HOLDINGS, now: NOW });
    assert.equal(terms.allotment, "960000");
    assert.equal(terms.minDepth, "19000");
    assert.equal(terms.defensiveDepth, "31000");
    assert.equal(terms.floor, "0.3");
    const built = buildPolicy(terms, { base: BASE, quote: QUOTE, oracle: ORACLE });
    assert.ok(!("error" in built), "error" in built ? built.error : "");
  });

  test("policy fields are explained against the pool", () => {
    const terms = suggestPolicy({ base: BASE, quote: QUOTE, market: MARKET, holdings: HOLDINGS, now: NOW });
    const { fields, summary } = explainPolicy(terms, { base: BASE, quote: QUOTE, market: MARKET, holdings: HOLDINGS, now: NOW });
    assert.match(fields.floor!, /25% under today's 0\.4/);
    assert.match(fields.releaseStart!, /already unlocked/);
    assert.match(fields.minDepth!, /This pool passes/);
    assert.match(fields.shortTwapMinutes!, /volatility always reads 0/);
    assert.ok(summary.some((s) => /normal mode/.test(s)), summary.join(" | "));
  });

  test("a pool still settling or too young reads as paused, with the reason", () => {
    const terms = { ...suggestPolicy({ base: BASE, quote: QUOTE, market: MARKET, now: NOW }), minPoolAgeHours: "2" };
    const fresh = { ...MARKET, trustedLiquidity: 0n, poolAgeSeconds: 300 };
    const { fields, summary } = explainPolicy(terms, { base: BASE, quote: QUOTE, market: fresh, now: NOW });
    assert.match(fields.minDepth!, /would pause until its liquidity settles/);
    assert.ok(summary.some((s) => /paused, waiting for .*pool age/.test(s)), summary.join(" | "));
  });

  test("suggested strategy starts at the pool price and explains spread and backing", () => {
    const terms = suggestTerms({ base: BASE, quote: QUOTE, mm: "0x5F8b93e830a42200CB85420e89BE5FC9154F9192", anchorPriceX36: PRICE_X36, holdings: HOLDINGS });
    assert.equal(terms.shippedBase, "250000");
    assert.equal(terms.shippedQuote, "100000");
    const { fields } = explainTerms(terms, { base: BASE, quote: QUOTE, anchorPriceX36: PRICE_X36, holdings: HOLDINGS });
    assert.match(fields.spreadPct!, /takers buy at ≈0\.4032/);
    assert.match(fields.shippedQuote!, /the same as the pool/);
    assert.match(explainTerms({ ...terms, shippedBase: "99999999" }, { base: BASE, quote: QUOTE, holdings: HOLDINGS }).fields.shippedBase!, /will be refused/);
  });

  test("without a pool price the quote side is left to the issuer", () => {
    assert.equal(suggestTerms({ base: BASE, quote: QUOTE }).shippedQuote, "");
  });
});

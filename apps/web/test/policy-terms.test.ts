import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Address } from "viem";

import { buildPolicy, decodePolicy, EMPTY_POLICY, encodePolicy, policyToTerms, type PolicyTerms } from "../src/issuer/policy.ts";
import { suggestPolicy } from "../src/issuer/explain.ts";
import type { TokenRef } from "../src/issuer/terms.ts";

/** Pure conversion of a typed treasury policy into createPolicy's PolicyConfig. Values are test inputs. */
const ORACLE = "0x9B78f6553A921D1bea0722CAd111CDAE4299522B" as Address;
const BASE: TokenRef = { address: "0xf53280706fdc2f0f82e1c3bceb61fd8d6b58104e", symbol: "dLAUNCH", decimals: 18 };
const QUOTE: TokenRef = { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6 };
const ctx = { base: BASE, quote: QUOTE, oracle: ORACLE };

const POLICY: PolicyTerms = {
  allotment: "1000000", releaseStart: "2026-11-06", releaseDays: "180", periodHours: "24", grossCap: "100000",
  netCap: "50000", quoteSpendCap: "20000", floor: "0.30", quoteDeviationPct: "3", impactPct: "3", twapMinutes: "30",
  shortTwapMinutes: "5", depthBandPct: "5", minPoolAgeHours: "1", minDepth: "50000", defensiveDepth: "100000",
  defensiveMovePct: "2", pauseMovePct: "10", defensiveVolatilityPct: "3", pauseVolatilityPct: "15",
  normalMaxFill: "50000", normalDepthSharePct: "20", normalMinSpreadPct: "0", normalBuybacks: "yes",
  defensiveMaxFill: "10000", defensiveDepthSharePct: "10", defensiveMinSpreadPct: "1.5", defensiveBuybacks: "no",
};
const error = (overrides: Partial<PolicyTerms>) => {
  const built = buildPolicy({ ...POLICY, ...overrides }, ctx);
  return "error" in built ? built.error : undefined;
};

describe("policy terms", () => {
  test("a typed policy becomes the exact PolicyConfig", () => {
    const built = buildPolicy(POLICY, ctx);
    assert.ok(!("error" in built), "error" in built ? built.error : "");
    const c = built.config;
    assert.deepEqual(c.release, { allotment: 10n ** 24n, releaseStart: 1_793_923_200n, releaseDuration: 180n * 86_400n });
    assert.deepEqual(c.period, { periodLength: 86_400n, grossSellCap: 10n ** 23n, netSellCap: 5n * 10n ** 22n, quoteSpendCap: 2n * 10n ** 10n });
    assert.deepEqual(c.price, { floorPriceX36: 3n * 10n ** 23n, maxQuoteDeviationBps: 300, maxImpactBps: 300 });
    assert.equal(c.oracle.oracle, ORACLE);
    assert.equal(c.oracle.twapWindow, 1800);
    assert.equal(c.oracle.shortWindow, 300);
    assert.equal(c.oracle.minPoolAge, 3600);
    assert.equal(c.oracle.pauseMoveBps, 1000);
    assert.deepEqual(c.defensive, { maxFillBase: 10n ** 22n, maxFillDepthBps: 1000, minSpreadBps: 150, buybacksAllowed: false });
    assert.deepEqual(built.warnings, []);
  });

  test("nothing is assumed: an empty policy is refused", () => {
    assert.match((buildPolicy(EMPTY_POLICY, ctx) as { error: string }).error, /Release start/);
    assert.match(error({ normalBuybacks: "" })!, /buybacks are allowed/);
  });

  test("the module's policy rules are explained before anyone signs", () => {
    assert.match(error({ netCap: "200000" })!, /must not exceed the gross sell limit/);
    assert.match(error({ shortTwapMinutes: "45" })!, /not be longer than the TWAP window/);
    assert.match(error({ depthBandPct: "100" })!, /below 100%/);
    assert.match(error({ defensiveMovePct: "20" })!, /must not exceed the pause threshold/);
    assert.match(error({ defensiveVolatilityPct: "20" })!, /must not exceed the pause threshold/);
    assert.match(error({ minDepth: "200000" })!, /at least the minimum depth/);
    assert.match(error({ defensiveMaxFill: "60000" })!, /largest fill must not exceed/);
    assert.match(error({ defensiveDepthSharePct: "30" })!, /share of depth must not exceed/);
    assert.match(error({ defensiveMinSpreadPct: "0", normalMinSpreadPct: "1" })!, /minimum spread must be at least/);
    assert.match(error({ normalBuybacks: "no", defensiveBuybacks: "yes" })!, /cannot allow buybacks/);
    assert.match(error({ releaseDays: "0" })!, /at least 1/);
  });

  test("permissive choices are allowed but flagged", () => {
    const built = buildPolicy({ ...POLICY, floor: "0", minDepth: "0", quoteSpendCap: "0" }, ctx);
    assert.ok(!("error" in built));
    assert.equal(built.config.price.floorPriceX36, 0n);
    assert.equal(built.warnings.length, 3);
  });

  test("the suggested values build a valid policy whose release has already started", () => {
    const now = new Date("2026-11-07T08:00:00Z");
    const terms = suggestPolicy({ base: BASE, quote: QUOTE, now });
    assert.equal(terms.releaseStart, "2026-10-08");
    const built = buildPolicy(terms, ctx);
    assert.ok(!("error" in built), "error" in built ? built.error : "");
    assert.equal(built.config.oracle.minPoolAge, 0);
    assert.equal(built.config.oracle.twapWindow, 60);
  });

  test("no minimum pool age is allowed and flagged; the TWAP windows still need at least a minute", () => {
    const built = buildPolicy({ ...POLICY, minPoolAgeHours: "0" }, ctx);
    assert.ok(!("error" in built));
    assert.equal(built.config.oracle.minPoolAge, 0);
    assert.ok(built.warnings.some((w) => /No minimum pool age/.test(w)));
    assert.match(error({ twapMinutes: "0" })!, /TWAP window: whole minutes, at least 1/);
  });

  test("an existing policy round-trips through the edit form unchanged", () => {
    const built = buildPolicy(POLICY, ctx);
    assert.ok(!("error" in built));
    const again = buildPolicy(policyToTerms(built.config, BASE, QUOTE), ctx);
    assert.ok(!("error" in again));
    assert.deepEqual(again.config, built.config);
    // Indexer JSON (decimal strings) reads the same.
    const json = JSON.parse(JSON.stringify(built.config, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    assert.deepEqual(policyToTerms(json, BASE, QUOTE), policyToTerms(built.config, BASE, QUOTE));
  });

  test("policies survive the shareable link and junk is dropped", () => {
    assert.deepEqual(decodePolicy(encodePolicy(POLICY)), POLICY);
    assert.deepEqual(decodePolicy(JSON.stringify({ floor: "0.3", evil: "x", netCap: 5 })), { floor: "0.3" });
    assert.equal(decodePolicy("{"), null);
  });
});

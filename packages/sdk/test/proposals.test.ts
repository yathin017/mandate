import assert from "node:assert/strict";
import { test } from "node:test";

import { recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { hashStrategyTerms, strategyTermsTypedData, termsFromJson, termsToJson, type StrategyTerms } from "../src/proposals.ts";

// Anvil account #2: a public development key.
const mm = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const deployment = { chainId: 8453, module: "0xC10ED38aDfB53c5E1262194d4Db420f6Fa82544d" as Address };
const safe = "0xB88E30325557e7C7fD409F661C1C1060476C5456" as Address;
const terms: StrategyTerms = {
  marketMaker: mm.address,
  base: "0xB515f7b4136D5282F2186838e02a19A156bC9A9B",
  quote: "0x7F8a933C627747Cd5A1B6b828FD48F1649C9C8a2",
  kind: 0,
  bounds: { spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 10n ** 24n, maxShippedQuote: 4n * 10n ** 11n,
    mmFeeShareBps: 5000, maxBuyPriceX36: 0n },
  params: { spreadBps: 80, shippedBase: 10n ** 24n, shippedQuote: 4n * 10n ** 11n },
};
const input = { proposalId: "6f1c1f5e-0000-4000-8000-000000000001", safe, terms, expiresAt: 1_800_000_000n };

test("terms survive the JSON form exactly", () => {
  const json = termsToJson(terms);
  assert.equal(json.marketMaker, mm.address.toLowerCase());
  assert.equal(json.bounds.maxShippedBase, "1000000000000000000000000");
  assert.equal(json.kind, "0");
  assert.deepEqual(termsFromJson(JSON.parse(JSON.stringify(json))), terms);
});

test("out-of-range or malformed JSON is refused", () => {
  const json = termsToJson(terms);
  assert.throws(() => termsFromJson({ ...json, bounds: { ...json.bounds, spreadBpsMax: "65536" } }), /uint16/);
  assert.throws(() => termsFromJson({ ...json, bounds: { ...json.bounds, maxShippedBase: "-1" } }), /unsigned/);
  assert.throws(() => termsFromJson({ ...json, kind: "2" }), /unknown strategy kind/);
  assert.throws(() => termsFromJson({ ...json, base: "0x123" }), /base: not an address/);
});

test("the acceptance signature recovers to the market maker and binds every field", async () => {
  const typed = strategyTermsTypedData(deployment, input);
  const signature = await mm.signTypedData(typed);
  assert.equal(await recoverTypedDataAddress({ ...typed, signature }), mm.address);
  const base = hashStrategyTerms(deployment, input);
  assert.notEqual(hashStrategyTerms(deployment, { ...input, expiresAt: input.expiresAt + 1n }), base);
  assert.notEqual(hashStrategyTerms({ ...deployment, chainId: 1 }, input), base);
  assert.notEqual(hashStrategyTerms(deployment, { ...input, terms: { ...terms, params: { ...terms.params, spreadBps: 81 } } }), base);
  assert.notEqual(hashStrategyTerms(deployment, { ...input, terms: { ...terms, kind: 1 } }), base);
  assert.equal(typed.domain?.version, "2", "v1 mandate acceptances cannot be replayed as strategy acceptances");
});

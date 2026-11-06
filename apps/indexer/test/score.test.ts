import assert from "node:assert/strict";
import { test } from "node:test";

import { classify } from "../src/score/prober.ts";
import { computeScores, WEIGHTS, type MmEvidence } from "../src/score/score.ts";

/** Pure scoring rules; no chain or database needed. */
const base: MmEvidence = {
  mm: "0xaa", okRounds: 0, faultRounds: 0, responseMinutes: [], fills: 0, quoteVolume: 0, weightedDeviation: 0,
  mandates: 1, revoked: 0, managedDays: 30,
};

test("weights add up to one and match the agreed split", () => {
  assert.deepEqual(WEIGHTS, { availability: 0.35, priceQuality: 0.2, volume: 0.2, reliability: 0.15, responsiveness: 0.1 });
  assert.equal(Object.values(WEIGHTS).reduce((a, b) => a + b, 0), 1);
});

test("a market maker without probes or fills is new, never zero", () => {
  const [score] = computeScores([{ ...base, okRounds: 3 }]);
  assert.equal(score!.status, "new");
  assert.equal(score!.score, null);
});

test("a perfect record scores 100; components follow their formulas", () => {
  const [perfect, other] = computeScores([
    { ...base, mm: "0xaa", okRounds: 10, fills: 4, quoteVolume: 1000, weightedDeviation: 0 },
    { ...base, mm: "0xbb", okRounds: 6, faultRounds: 4, responseMinutes: [30, 90, 60], fills: 1, quoteVolume: 9, weightedDeviation: 4.5, mandates: 2, revoked: 1, managedDays: 15 },
  ]);
  assert.equal(perfect!.score, 100);
  const c = other!.components;
  assert.equal(c.availability.value, 0.6);
  assert.equal(c.priceQuality.value, 0.5); // half of the tolerance on average
  assert.equal(c.volume.value, Math.round((Math.log10(10) / Math.log10(1001)) * 1000) / 1000);
  assert.equal(c.reliability.value, 0.25); // half kept × half the tenure
  assert.equal(c.responsiveness.value, 0.5); // median 60 of 120 minutes
  const expected = 0.35 * 0.6 + 0.2 * 0.5 + 0.2 * c.volume.value! + 0.15 * 0.25 + 0.1 * 0.5;
  assert.equal(other!.score, Math.round(100 * expected));
});

test("missing components are reported and the rest are rescaled", () => {
  // Probed but never filled: no price quality or volume.
  const [score] = computeScores([{ ...base, okRounds: 9, faultRounds: 1 }]);
  assert.equal(score!.components.priceQuality.value, null);
  assert.equal(score!.components.volume.value, null);
  assert.equal(score!.components.responsiveness.value, 1, "probed with no faults to fix");
  const expected = (0.35 * 0.9 + 0.15 * 1 + 0.1 * 1) / (0.35 + 0.15 + 0.1);
  assert.equal(score!.score, Math.round(100 * expected));
});

test("only refusals the market maker controls count against it", () => {
  assert.equal(classify(null), "ok");
  for (const name of ["AnchorDeviation", "InsufficientLiquidity", "ZeroBalance"]) assert.equal(classify(name), "mm_fault");
  for (const name of ["BelowFloor", "EpochCapReached", "ReleaseExceeded", "SpotTwapDivergence", "UnknownError"]) assert.equal(classify(name), "neutral");
});

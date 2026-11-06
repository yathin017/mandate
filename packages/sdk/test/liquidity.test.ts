import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFunctionData, parseAbi, type Address } from "viem";

import { buildAddLiquidityCall, fullRangeTicks, MAX_TICK, MIN_TICK, planFullRangeLiquidity, sqrtPriceAtTick } from "../src/liquidity.ts";

test("tick math matches v4-core's bounds and identity", () => {
  assert.equal(sqrtPriceAtTick(0), 1n << 96n);
  assert.equal(sqrtPriceAtTick(MIN_TICK), 4295128739n); // TickMath.MIN_SQRT_PRICE
  assert.equal(sqrtPriceAtTick(MAX_TICK), 1461446703485210103287273052203988822378723970342n); // TickMath.MAX_SQRT_PRICE
  assert.throws(() => sqrtPriceAtTick(MAX_TICK + 1));
  assert.deepEqual(fullRangeTicks(60), { tickLower: -887220, tickUpper: 887220 });
});

test("a full-range plan at 0.40 pairs 100,000 base with ~40,000 quote and caps both", () => {
  const base = "0x00000000000000000000000000000000000000b0" as Address; // sorts after quote: base is currency1
  const quote = "0x00000000000000000000000000000000000000a0" as Address;
  const poolKey = { currency0: quote, currency1: base, fee: 3000, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000001080" as Address };
  // 1 base (1e18 raw) = 0.40 quote (4e5 raw). The pool price is currency1 per currency0 = base per quote = 1e18 / 4e5.
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(1e18 / 4e5) * 2 ** 48)) << 48n;
  const plan = planFullRangeLiquidity({ poolKey, sqrtPriceX96, base, baseAmount: 100_000n * 10n ** 18n });
  const quoteNeeded = Number(plan.amount0) / 1e6;
  assert.ok(Math.abs(quoteNeeded - 40_000) / 40_000 < 1e-3, `quote ${quoteNeeded}`);
  assert.ok(plan.amount1 <= 100_000n * 10n ** 18n + 1n);
  assert.ok(plan.amount0Max > plan.amount0 && plan.amount1Max > plan.amount1, "1% slippage caps");

  const safe = "0xB88E30325557e7C7fD409F661C1C1060476C5456" as Address;
  const call = buildAddLiquidityCall(8453, safe, plan);
  assert.equal(call.operation, 1);
  assert.equal(call.to, "0x9641d764fc13c8B624c04430C7356C1C7C8102e2");
  const { functionName } = decodeFunctionData({ abi: parseAbi(["function multiSend(bytes transactions) payable"]), data: call.data });
  assert.equal(functionName, "multiSend");
});

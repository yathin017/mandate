import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeFunctionData, type Address } from "viem";

import { tokenFactoryAbi } from "../src/abis.ts";
import { buildLaunchTokenCall, launchProblem, MAX_LAUNCH_SUPPLY, randomLaunchSalt } from "../src/launch.ts";

const factory = "0x00000000000000000000000000000000000000f1" as Address;
const safe = "0xB88E30325557e7C7fD409F661C1C1060476C5456" as Address;
const launch = { name: "Nova", symbol: "NOVA", supply: 10n ** 27n, recipient: safe, salt: randomLaunchSalt() };

test("validation mirrors TokenFactory", () => {
  assert.equal(launchProblem(launch), null);
  for (const [field, value, pattern] of [
    ["name", "", /1 to 64/], ["name", " Nova", /spaces/], ["name", "Növa", /plain/], ["name", "a".repeat(65), /1 to 64/],
    ["symbol", "USDC.e", /letters or digits/], ["symbol", "ABCDEFGHIJKL", /letters or digits/],
    ["supply", 0n, /Supply/], ["supply", MAX_LAUNCH_SUPPLY + 1n, /Supply/],
    ["recipient", "0x0000000000000000000000000000000000000000", /Recipient/],
  ] as const) {
    assert.match(launchProblem({ ...launch, [field]: value }) ?? "", pattern, `${field}=${String(value)}`);
  }
});

test("the launch call targets the factory with the exact arguments", () => {
  const call = buildLaunchTokenCall(8453, factory, launch);
  assert.equal(call.to, factory);
  assert.equal(call.role, "anyone");
  const decoded = decodeFunctionData({ abi: tokenFactoryAbi, data: call.data });
  assert.equal(decoded.functionName, "launch");
  assert.deepEqual(decoded.args, [launch.name, launch.symbol, launch.supply, safe, launch.salt]);
  assert.throws(() => buildLaunchTokenCall(8453, factory, { ...launch, symbol: "" }), /Symbol/);
  assert.notEqual(randomLaunchSalt(), randomLaunchSalt());
});

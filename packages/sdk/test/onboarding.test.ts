import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeFunctionData, getAddress, type Address } from "viem";
import { getChainConfig } from "@mandate/chains";
import { ANCHOR_POOL_FEE, ANCHOR_POOL_TICK_SPACING, anchorLauncherAbi, anchorPoolKey, buildCreateSafeCall,
  buildEnableModuleCall, buildLaunchAnchorCall, buildMintCall, encodeSafeSetup, labelToken, mockErc20Abi,
  mockTokenDeployment, poolIdOf, priceX36FromSqrtPrice, safeAbi, safeProxyFactoryAbi } from "@mandate/sdk";

const fixtures = JSON.parse(await readFile(new URL("./fixtures/solidity.json", import.meta.url), "utf8"));
const HOOK = "0x30Ff096F8582363807a9b5Cb15b84E7d98371080" as Address;
const A = "0x0000000000000000000000000000000000001000" as Address;
const B = "0x0000000000000000000000000000000000002000" as Address;

/** Integer square root, for building test sqrt prices exactly like AnchorLauncher.sqrtPriceX96For. */
function sqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

test("anchor PoolId matches the Solidity PoolIdLibrary vector, whichever token is base", () => {
  assert.equal(poolIdOf(anchorPoolKey(HOOK, B, A)), fixtures.anchorPoolId);
  assert.equal(poolIdOf(anchorPoolKey(HOOK, A, B)), fixtures.anchorPoolId);
  assert.equal(anchorPoolKey(HOOK, B, A).currency0, getAddress(A));
  assert.equal(ANCHOR_POOL_FEE, 3000);
  assert.equal(ANCHOR_POOL_TICK_SPACING, 60);
});

test("pool price converts to base-in-quote X36 units in both orientations", () => {
  const price = 4n * 10n ** 23n; // 0.40 (6dp quote per 18dp base)
  const asCurrency0 = sqrt((price << 192n) / 10n ** 36n);
  const asCurrency1 = sqrt((10n ** 36n << 192n) / price);
  const rel = (x: bigint) => Number(x > price ? x - price : price - x) / Number(price);
  assert.ok(rel(priceX36FromSqrtPrice(asCurrency0, true)) < 1e-9);
  assert.ok(rel(priceX36FromSqrtPrice(asCurrency1, false)) < 1e-9);
  assert.equal(priceX36FromSqrtPrice(0n, true), 0n);
});

test("launch call encodes the pair and refuses a zero price", () => {
  const call = buildLaunchAnchorCall(8453, B, { base: A, quote: B, initialPriceX36: 7n });
  assert.equal(call.role, "anyone");
  const decoded = decodeFunctionData({ abi: anchorLauncherAbi, data: call.data });
  assert.equal(decoded.functionName, "launch");
  assert.deepEqual(decoded.args, [getAddress(A), getAddress(B), 7n]);
  assert.throws(() => buildLaunchAnchorCall(8453, B, { base: A, quote: B, initialPriceX36: 0n }), /positive/);
});

test("Safe setup matches the Solidity vector and validates owners and threshold", () => {
  assert.equal(encodeSafeSetup([A, B], 2), fixtures.safeSetup);
  assert.throws(() => encodeSafeSetup([], 1), /at least one owner/);
  assert.throws(() => encodeSafeSetup([A, A], 1), /unique/);
  assert.throws(() => encodeSafeSetup([A, B], 0), /Threshold/);
  assert.throws(() => encodeSafeSetup([A, B], 3), /Threshold/);
  assert.throws(() => encodeSafeSetup(["0x0000000000000000000000000000000000000000"], 1), /Invalid owner/);
});

test("Safe creation targets the chain's canonical factory and singleton", () => {
  const base = getChainConfig(8453);
  const call = buildCreateSafeCall(8453, { owners: [A, B], threshold: 2, saltNonce: 9n });
  assert.equal(call.to, base.safe.proxyFactory);
  const decoded = decodeFunctionData({ abi: safeProxyFactoryAbi, data: call.data });
  assert.equal(decoded.functionName, "createProxyWithNonce");
  assert.deepEqual(decoded.args, [base.safe.singletonL2, fixtures.safeSetup, 9n]);
});

test("module enablement is a call from the Safe to itself", () => {
  const call = buildEnableModuleCall(8453, A, B);
  assert.equal(call.to, A);
  assert.equal(call.role, "issuer-safe");
  const decoded = decodeFunctionData({ abi: safeAbi, data: call.data });
  assert.equal(decoded.functionName, "enableModule");
  assert.deepEqual(decoded.args, [getAddress(B)]);
});

test("canonical tokens are labelled and look-alikes are flagged", () => {
  const { tokens } = getChainConfig(8453);
  assert.equal(labelToken(8453, tokens.usdc, "USDC").canonical, "USDC");
  assert.equal(labelToken(8453, tokens.weth, "WETH").canonical, "WETH");
  assert.match(labelToken(8453, A, "USDC").warning ?? "", /not the canonical USDC/);
  assert.match(labelToken(8453, A, "USDC.e").warning ?? "", /USDC/);
  assert.equal(labelToken(8453, A, "mLAUNCH").warning, null);
});

test("mock tokens must be labelled as demo tokens", () => {
  const request = mockTokenDeployment("Demo Launch", "dLAUNCH", 18);
  assert.match(request.bytecode, /^0x[0-9a-f]{200,}$/);
  assert.deepEqual(request.args, ["Demo Launch", "dLAUNCH", 18]);
  assert.throws(() => mockTokenDeployment("USD Coin", "USDC", 6), /Demo/);
  assert.throws(() => mockTokenDeployment("Demo X", "bad symbol!", 6), /Symbol/);
  const mint = buildMintCall(8453, A, B, 5n);
  assert.equal(mint.role, "token-owner");
  assert.deepEqual(decodeFunctionData({ abi: mockErc20Abi, data: mint.data }).args, [getAddress(B), 5n]);
});

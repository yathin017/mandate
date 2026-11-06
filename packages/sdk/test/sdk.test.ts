import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, decodeFunctionData, encodeErrorResult,
  getAbiItem, getAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { getLocalForkDeployment } from "@mandate/chains";
import { ERROR_MESSAGES, mandateModuleAbi, mandateQuoterAbi, mandateOracleHookAbi, uniswapV4TwapAnchorAbi,
  swapVmAbi, erc20Abi, erc20ErrorsAbi, buildClaimFeesCall, buildPauseCall, buildUnpauseCall, buildRevokeCall, buildReshipCall,
  buildCreateMandateCall, buildUpdateBoundsCall, buildApproveRouterCall, buildSwapCall, encodeTakerData,
  hashAquaOrder, explainError, formatPriceX36, parsePriceX36, formatTokenAmount, createMandateClient } from "@mandate/sdk";

const deployment = getLocalForkDeployment();
const fixtures = JSON.parse(await readFile(new URL("./fixtures/solidity.json", import.meta.url), "utf8"));
const replay = JSON.parse(await readFile(new URL("../../../replay/data/acts.json", import.meta.url), "utf8"));
const id = deployment.mandates.act1;
const tokenContext = { base: { symbol: "LAUNCH", decimals: 18 }, quote: { symbol: "sUSDC", decimals: 6 } };

test("SDK taker data exactly matches vectors from pinned TakerTraitsLib.build", () => {
  const cases = {
    exactInQuote: { isExactIn: true }, exactOutQuote: { isExactIn: false },
    exactInLimited: { isExactIn: true, threshold: 1001n, deadline: 1_800_000_000n },
    exactOutLimited: { isExactIn: false, threshold: 1001n, deadline: 1_800_000_000n },
    zeroThreshold: { isExactIn: true, threshold: 0n },
    maxValues: { isExactIn: false, threshold: (1n << 256n) - 1n, deadline: (1n << 40n) - 1n },
  };
  for (const [name, args] of Object.entries(cases)) assert.equal(encodeTakerData(args), fixtures[name], name);
  assert.throws(() => encodeTakerData({ isExactIn: true, deadline: 1n << 40n }), /uint40/);
  assert.throws(() => encodeTakerData({ isExactIn: true, threshold: -1n }), /uint256/);
});

test("Aqua order hashing matches the pinned onchain MandateStrategy library", () => {
  const hashFunction = getAbiItem({ abi: swapVmAbi, name: "hash" });
  const [solidityOrder] = decodeAbiParameters(hashFunction.inputs, fixtures.orderEncoded);
  assert.equal(hashAquaOrder(solidityOrder), fixtures.orderHash);
});

const order = { maker: getAddress("0x0000000000000000000000000000000000001000"), traits: 0n, data: "0x" as Hex };
test("submit-ready swap payload requires explicit price protection and expiry", () => {
  const input = { order, tokenIn: deployment.quote, tokenOut: deployment.base, amount: 100n,
    isExactIn: true, threshold: 90n, deadline: 1_800_000_000n };
  const call = buildSwapCall(deployment, input);
  assert.equal(call.role, "taker");
  const decoded = decodeFunctionData({ abi: swapVmAbi, data: call.data });
  assert.equal(decoded.functionName, "swap");
  assert.deepEqual(decoded.args?.slice(1, 4), [deployment.quote, deployment.base, 100n]);
  assert.throws(() => buildSwapCall(deployment, { ...input, threshold: 0n }), /positive/);
  assert.throws(() => buildSwapCall(deployment, { ...input, deadline: 0n }), /positive/);
  const approve = decodeFunctionData({ abi: erc20Abi, data: buildApproveRouterCall(deployment, deployment.quote, 100n).data });
  if (approve.functionName !== "approve") throw new Error("Wrong approval function");
  assert.equal(getAddress(approve.args[0]), getAddress(call.to), "EOA settlement approves the router");
});

test("module calldata preserves role boundaries and direct claims", () => {
  for (const [builder, name, role] of [
    [buildPauseCall, "pause", "either"], [buildUnpauseCall, "unpause", "issuer-safe"],
    [buildRevokeCall, "revoke", "issuer-safe"], [buildClaimFeesCall, "claimFees", "market-maker"],
  ] as const) {
    const call = builder(deployment, id);
    assert.equal(call.to, deployment.module);
    assert.equal(call.chainId, 31337);
    assert.equal(call.role, role);
    assert.equal(call.value, 0n);
    assert.equal(call.operation, 0);
    const decoded = decodeFunctionData({ abi: mandateModuleAbi, data: call.data });
    assert.equal(decoded.functionName, name);
    assert.deepEqual(decoded.args, [id]);
  }
});

const bounds = { allotment: 10_000_000n * 10n ** 18n, releaseStart: 1_790_000_000n,
  releaseDuration: 180n * 86400n, epochLength: 86400n, maxEpochCap: 50_000n * 10n ** 18n,
  maxShippedQuote: 4_000_000n * 10n ** 6n, floorPriceX36: 3n * 10n ** 23n,
  maxAnchorDeviationBps: 300, twapWindow: 1800, spreadBpsMin: 10, spreadBpsMax: 200,
  mmFeeShareBps: 5000, anchor: deployment.anchor };
const params = { spreadBps: 30, epochCap: bounds.maxEpochCap, shippedBase: bounds.allotment, shippedQuote: bounds.maxShippedQuote };
test("creation and bounds updates force the module's quoter and preserve bigint amounts", () => {
  const call = buildCreateMandateCall(deployment, { marketMaker: deployment.mm, base: deployment.base,
    quote: deployment.quote, bounds, params });
  const decoded = decodeFunctionData({ abi: mandateModuleAbi, data: call.data });
  assert.equal(decoded.functionName, "createMandate");
  if (decoded.functionName !== "createMandate") throw new Error("Wrong function");
  assert.equal(getAddress(decoded.args[3].quoter), deployment.quoter);
  assert.equal(decoded.args[3].allotment, bounds.allotment);
  assert.equal(buildUpdateBoundsCall(deployment, id, bounds).role, "issuer-safe");
  assert.equal(buildReshipCall(deployment, id, params).role, "market-maker");
});

function sample(type: string): unknown {
  if (type === "address") return deployment.safe1;
  if (type === "bytes32") return id;
  if (type === "bytes") return "0x";
  if (type === "string") return "epochCap";
  if (/^u?int\d*$/.test(type)) return 10n;
  throw new Error(`Unhandled fixture type ${type}`);
}
test("every custom error in production ABIs has a plain-language mapping", () => {
  const abis: Abi[] = [mandateModuleAbi, mandateQuoterAbi, uniswapV4TwapAnchorAbi, mandateOracleHookAbi];
  for (const abi of abis) {
    for (const error of abi.filter((item) => item.type === "error")) {
      assert.ok(error.name in ERROR_MESSAGES, error.name);
      const encoded = encodeErrorResult({ abi, errorName: error.name, args: error.inputs.map((arg) => sample(arg.type)) });
      const decoded = explainError(encoded, tokenContext);
      assert.equal(decoded.errorName, error.name);
      assert.ok(decoded.message.length > 20);
    }
  }
});

test("saved replay revert data is decoded consistently with its recorded outcome", () => {
  let checked = 0;
  for (const act of replay.acts) for (const step of act.steps) {
    if (step.outcome !== "blocked") continue;
    const decoded = explainError(step.returnData, tokenContext);
    assert.equal(decoded.errorName, step.error.name === "SafeError" ? "Error" : step.error.name);
    assert.deepEqual(decoded.args.map(String), step.error.args);
    assert.ok(decoded.message.length > 20);
    checked++;
  }
  assert.equal(checked, 156);
});

test("limit, release, floor and manipulation messages use correct token units", () => {
  const cap = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "EpochCapReached", args: [50_000n * 10n ** 18n, 1000n * 10n ** 18n, 50_000n * 10n ** 18n] });
  const decoded = explainError(cap, { ...tokenContext, now: 100n, epochResetsAt: 160n });
  assert.match(decoded.message, /50000 LAUNCH/);
  assert.match(decoded.message, /1000 LAUNCH/);
  assert.match(decoded.message, /60 seconds/);
  const floor = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "BelowFloor", args: [3n * 10n ** 23n, 4n * 10n ** 23n] });
  assert.match(explainError(floor, tokenContext).message, /0\.3 sUSDC\/LAUNCH.*0\.4/);
  const spot = encodeErrorResult({ abi: uniswapV4TwapAnchorAbi, errorName: "SpotTwapDivergence", args: [6n, 4n, 5000n, 200n] });
  assert.match(explainError(spot).message, /50%.*2%/);
});

test("Safe wrappers, viem errors, empty data and cyclic provider causes fail safely", () => {
  const inner = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "MandatePaused" });
  const outer = encodeErrorResult({ abi: mandateModuleAbi, errorName: "SafeCallFailed", args: [deployment.module, inner] });
  assert.equal(explainError(outer).cause?.errorName, "MandatePaused");
  const insolvent = encodeErrorResult({ abi: erc20ErrorsAbi, errorName: "ERC20InsufficientBalance", args: [deployment.safe1, 0n, 10n] });
  const wrapped = encodeErrorResult({ abi: mandateModuleAbi, errorName: "SafeCallFailed", args: [deployment.base, insolvent] });
  assert.equal(explainError(wrapped).cause?.errorName, "ERC20InsufficientBalance");
  assert.match(explainError(wrapped).message, /balance is too low/);
  const reverted = new ContractFunctionRevertedError({ abi: mandateQuoterAbi, data: inner, functionName: "extruction" });
  assert.equal(explainError(new BaseError("RPC failed", { cause: reverted })).errorName, "MandatePaused");
  assert.equal(explainError({ data: "0x", cause: { data: inner } }).errorName, "MandatePaused");
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  for (const input of [cycle, "0x", "0xdeadbeef", "0x123", { transaction: { data: inner } }]) {
    assert.equal(explainError(input).errorName, "UnknownError");
  }
});

test("price formatting accounts for token decimals and never silently rounds input", () => {
  assert.equal(parsePriceX36("0.4", 18, 6), 4n * 10n ** 23n);
  assert.equal(formatPriceX36(4n * 10n ** 23n, 18, 6), "0.4");
  assert.equal(formatTokenAmount(10n ** 30n + 1n, { decimals: 18, symbol: "TOKEN" }), "1000000000000.000000000000000001 TOKEN");
  assert.match(formatPriceX36(1n, 18, 6), /^</);
  assert.throws(() => parsePriceX36("0.0000000000000000000000001", 18, 6), /precision/);
  assert.throws(() => parsePriceX36("1e-3", 18, 6), /unsigned decimal/);
  assert.throws(() => formatPriceX36(-1n, 18, 6), /negative/);
  assert.throws(() => formatPriceX36(1n, 18.5, 6), /decimals/);
});

test("client rejects network mismatch and absent deployments before reading contract state", async () => {
  await assert.rejects(createMandateClient({ getChainId: async () => 1 } as unknown as PublicClient, deployment), /does not match/);
  await assert.rejects(createMandateClient({ getChainId: async () => 31337, getCode: async () => "0x" } as unknown as PublicClient, deployment), /not deployed/);
});

function mockClient(options: { reorg?: boolean; anchorError?: Hex; quoteError?: Hex } = {}) {
  const calls: { functionName: string; blockNumber?: bigint }[] = [];
  let headers = 0;
  const values: Record<string, unknown> = {
    QUOTER: deployment.quoter, ROUTER: buildSwapCall(deployment, { order, tokenIn: deployment.quote,
      tokenOut: deployment.base, amount: 1n, isExactIn: true, threshold: 1n, deadline: 1n }).to,
    AQUA: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a",
    getMandate: { safe: deployment.safe1, mm: deployment.mm, base: deployment.base, quote: deployment.quote,
      status: 1, activeStrategyHash: hashAquaOrder(order), bounds: { ...bounds, quoter: deployment.quoter }, params },
    epochState: [1n, 0n, 0n], released: 1000n, remainingThisEpoch: 1000n, sellableNow: 1000n,
    epochResetsAt: 2000n, feesAccrued: [0n, 0n], claimable: [0n, 0n], claimed: [0n, 0n], activeOrder: order,
    snapshot: [6n, 4n, 5000n], MAX_SPOT_DEVIATION_BPS: 200,
  };
  const client = {
    getChainId: async () => 31337,
    getCode: async () => "0x01",
    getBlock: async () => ({ number: 100n, timestamp: 1800n,
      hash: `0x${((++headers > 1 && options.reorg) ? "22" : "11").repeat(32)}` }),
    readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
      calls.push(request);
      if (request.functionName === "snapshot" && options.anchorError) throw { data: options.anchorError };
      if (request.functionName === "quote" && options.quoteError) throw { data: options.quoteError };
      if (!(request.functionName in values)) throw new Error(`Unexpected read ${request.functionName}`);
      return values[request.functionName];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

test("all snapshot reads share a confirmed block, and a tripped breaker stays visible", async () => {
  const { client, calls } = mockClient();
  const sdk = await createMandateClient(client, deployment);
  const snapshot = await sdk.readSnapshot(id);
  assert.equal(snapshot.anchor.status, "blocked");
  assert.equal(snapshot.source.blockNumber, 100n);
  assert.ok(calls.filter((call) => !["QUOTER", "ROUTER", "AQUA"].includes(call.functionName))
    .every((call) => call.blockNumber === 100n));
});

test("missing oracle history produces unavailable health, not a healthy fallback price", async () => {
  const error = encodeErrorResult({ abi: mandateOracleHookAbi, errorName: "TargetPredatesOldestObservation", args: [100, 10] });
  const sdk = await createMandateClient(mockClient({ anchorError: error }).client, deployment);
  const snapshot = await sdk.readSnapshot(id);
  assert.equal(snapshot.anchor.status, "unavailable");
  if (snapshot.anchor.status === "unavailable") assert.equal(snapshot.anchor.error.errorName, "TargetPredatesOldestObservation");
});

test("reorgs reject snapshots and failed quotes instead of attaching incorrect provenance", async () => {
  const cap = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "EpochCapReached", args: [1n, 1n, 1n] });
  const sdk = await createMandateClient(mockClient({ reorg: true }).client, deployment);
  await assert.rejects(sdk.readSnapshot(id), /source block changed/);
  const quote = await createMandateClient(mockClient({ reorg: true, quoteError: cap }).client, deployment);
  await assert.rejects(quote.quote(id, { taker: deployment.deployer, tokenIn: deployment.quote,
    tokenOut: deployment.base, amount: 1n, isExactIn: true }), /source block changed/);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BaseError, ContractFunctionRevertedError, decodeAbiParameters, decodeFunctionData, encodeErrorResult,
  getAbiItem, getAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import { getLocalForkDeployment } from "@mandate/chains";
import { ERROR_MESSAGES, mandateModuleAbi, mandateQuoterAbi, mandateOracleHookAbi, uniswapV4MarketOracleAbi,
  swapVmAbi, erc20Abi, erc20ErrorsAbi, buildClaimFeesCall, buildPauseStrategyCall, buildUnpauseStrategyCall,
  buildRevokeStrategyCall, buildPausePolicyCall, buildUnpausePolicyCall, buildRevokePolicyCall, buildReshipCall,
  buildCreatePolicyCall, buildUpdatePolicyCall, buildAddStrategyCall, buildUpdateStrategyBoundsCall,
  buildApproveRouterCall, buildSwapCall, encodeTakerData, hashAquaOrder, explainError, formatPriceX36, parsePriceX36,
  formatTokenAmount, createMandateClient, riskReasonText, STRATEGY_KIND } from "@mandate/sdk";

const deployment = getLocalForkDeployment();
const fixtures = JSON.parse(await readFile(new URL("./fixtures/solidity.json", import.meta.url), "utf8"));
const replay = JSON.parse(await readFile(new URL("../../../replay/data/acts.json", import.meta.url), "utf8"));
const id = deployment.strategies.act1;
const policyId = deployment.policies.act1;
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
  for (const [builder, target, name, role] of [
    [buildPauseStrategyCall, id, "pauseStrategy", "either"], [buildUnpauseStrategyCall, id, "unpauseStrategy", "issuer-safe"],
    [buildRevokeStrategyCall, id, "revokeStrategy", "issuer-safe"], [buildClaimFeesCall, id, "claimFees", "market-maker"],
    [buildPausePolicyCall, policyId, "pausePolicy", "issuer-safe"], [buildUnpausePolicyCall, policyId, "unpausePolicy", "issuer-safe"],
    [buildRevokePolicyCall, policyId, "revokePolicy", "issuer-safe"],
  ] as const) {
    const call = builder(deployment, target);
    assert.equal(call.to, deployment.module);
    assert.equal(call.chainId, 31337);
    assert.equal(call.role, role);
    assert.equal(call.value, 0n);
    assert.equal(call.operation, 0);
    const decoded = decodeFunctionData({ abi: mandateModuleAbi, data: call.data });
    assert.equal(decoded.functionName, name);
    assert.deepEqual(decoded.args, [target]);
  }
});

const mode = (maxFillBase: bigint, maxFillDepthBps: number, minSpreadBps: number, buybacksAllowed: boolean) =>
  ({ maxFillBase, maxFillDepthBps, minSpreadBps, buybacksAllowed });
/** Test inputs only: on the platform every value is the issuer's choice. */
const config = {
  release: { allotment: 10_000_000n * 10n ** 18n, releaseStart: 1_790_000_000n, releaseDuration: 180n * 86400n },
  period: { periodLength: 86400n, grossSellCap: 100_000n * 10n ** 18n, netSellCap: 50_000n * 10n ** 18n,
    quoteSpendCap: 100_000n * 10n ** 6n },
  price: { floorPriceX36: 3n * 10n ** 23n, maxQuoteDeviationBps: 300, maxImpactBps: 300 },
  oracle: { oracle: deployment.anchor, twapWindow: 1800, shortWindow: 300, depthBandBps: 500, minPoolAge: 3600,
    minTrustedDepth: 100_000n * 10n ** 18n, defensiveMoveBps: 200, pauseMoveBps: 1000, defensiveVolatilityBps: 300,
    pauseVolatilityBps: 1500, defensiveDepth: 500_000n * 10n ** 18n },
  normal: mode(10n ** 24n, 5000, 0, true),
  defensive: mode(10n ** 23n, 2000, 150, false),
};
const bounds = { spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 10_000_000n * 10n ** 18n,
  maxShippedQuote: 4_000_000n * 10n ** 6n, mmFeeShareBps: 5000, maxBuyPriceX36: 0n };
const params = { spreadBps: 30, shippedBase: bounds.maxShippedBase, shippedQuote: bounds.maxShippedQuote };
test("policy and strategy builders encode the issuer's values exactly, as Safe calls", () => {
  const create = buildCreatePolicyCall(deployment, { base: deployment.base, quote: deployment.quote, config });
  const decoded = decodeFunctionData({ abi: mandateModuleAbi, data: create.data });
  assert.equal(decoded.functionName, "createPolicy");
  if (decoded.functionName !== "createPolicy") throw new Error("Wrong function");
  assert.deepEqual(decoded.args[2], config);
  assert.equal(create.role, "issuer-safe");
  assert.equal(buildUpdatePolicyCall(deployment, policyId, config).role, "issuer-safe");
  const add = buildAddStrategyCall(deployment, { policyId, marketMaker: deployment.mm, kind: STRATEGY_KIND.marketMaking, bounds, params });
  const addDecoded = decodeFunctionData({ abi: mandateModuleAbi, data: add.data });
  assert.equal(addDecoded.functionName, "addStrategy");
  if (addDecoded.functionName !== "addStrategy") throw new Error("Wrong function");
  assert.deepEqual(addDecoded.args, [policyId, deployment.mm, 0, bounds, params]);
  assert.equal(buildUpdateStrategyBoundsCall(deployment, id, bounds).role, "issuer-safe");
  assert.equal(buildReshipCall(deployment, id, params).role, "market-maker");
});

function sample(type: string): unknown {
  if (type === "address") return deployment.safe1;
  if (type === "bytes32") return id;
  if (type === "bytes") return "0x";
  if (type === "string") return "netSellCap";
  if (/^u?int\d*$/.test(type)) return 10n;
  throw new Error(`Unhandled fixture type ${type}`);
}
test("every custom error in production ABIs has a plain-language mapping", () => {
  const abis: Abi[] = [mandateModuleAbi, mandateQuoterAbi, uniswapV4MarketOracleAbi, mandateOracleHookAbi];
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
  assert.equal(checked, 157);
});

test("limit, release, floor and market-risk messages use correct token units", () => {
  const cap = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "NetSellCapReached", args: [50_000n * 10n ** 18n, 1000n * 10n ** 18n, 50_000n * 10n ** 18n] });
  const decoded = explainError(cap, { ...tokenContext, now: 100n, periodEndsAt: 160n });
  assert.match(decoded.message, /50000 LAUNCH/);
  assert.match(decoded.message, /1000 LAUNCH/);
  assert.match(decoded.message, /60 seconds/);
  const spend = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "QuoteSpendCapReached", args: [90n * 10n ** 6n, 20n * 10n ** 6n, 100n * 10n ** 6n] });
  assert.match(explainError(spend, tokenContext).message, /90 sUSDC.*100 sUSDC.*20 sUSDC/);
  const floor = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "BelowFloor", args: [3n * 10n ** 23n, 4n * 10n ** 23n] });
  assert.match(explainError(floor, tokenContext).message, /0\.3 sUSDC\/LAUNCH.*0\.4/);
  const offMarket = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "QuoteOffMarket", args: [4n * 10n ** 23n, 3n * 10n ** 23n, 3334n, 300n] });
  assert.match(explainError(offMarket, tokenContext).message, /33\.34%.*3%/);
  const paused = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "RiskPaused", args: [4] });
  assert.match(explainError(paused).message, /pause threshold/);
  const buybacks = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "BuybacksNotAllowed", args: [1] });
  assert.match(explainError(buybacks).message, /Defensive mode/);
  assert.equal(riskReasonText(99), "an unknown reason");
});

test("Safe wrappers, viem errors, empty data and cyclic provider causes fail safely", () => {
  const inner = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "StrategyPaused" });
  const outer = encodeErrorResult({ abi: mandateModuleAbi, errorName: "SafeCallFailed", args: [deployment.module, inner] });
  assert.equal(explainError(outer).cause?.errorName, "StrategyPaused");
  const insolvent = encodeErrorResult({ abi: erc20ErrorsAbi, errorName: "ERC20InsufficientBalance", args: [deployment.safe1, 0n, 10n] });
  const wrapped = encodeErrorResult({ abi: mandateModuleAbi, errorName: "SafeCallFailed", args: [deployment.base, insolvent] });
  assert.equal(explainError(wrapped).cause?.errorName, "ERC20InsufficientBalance");
  assert.match(explainError(wrapped).message, /balance is too low/);
  const reverted = new ContractFunctionRevertedError({ abi: mandateQuoterAbi, data: inner, functionName: "extruction" });
  assert.equal(explainError(new BaseError("RPC failed", { cause: reverted })).errorName, "StrategyPaused");
  assert.equal(explainError({ data: "0x", cause: { data: inner } }).errorName, "StrategyPaused");
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

function mockClient(options: { reorg?: boolean; quoteError?: Hex } = {}) {
  const calls: { functionName: string; blockNumber?: bigint }[] = [];
  let headers = 0;
  const health = { priced: true, spotX36: 6n, twapX36: 4n, shortTwapX36: 4n, trustedDepthBase: 10n ** 24n, poolAge: 7200 };
  const values: Record<string, unknown> = {
    QUOTER: deployment.quoter, ROUTER: buildSwapCall(deployment, { order, tokenIn: deployment.quote,
      tokenOut: deployment.base, amount: 1n, isExactIn: true, threshold: 1n, deadline: 1n }).to,
    AQUA: "0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a",
    getPolicy: { safe: deployment.safe1, base: deployment.base, quote: deployment.quote, status: 1, config },
    getStrategy: { policyId, mm: deployment.mm, kind: 0, status: 1, activeStrategyHash: hashAquaOrder(order), bounds, params },
    policyCounters: { periodIndex: 1n, grossSold: 0n, netSold: 0n, quoteSpent: 0n, totalNetSold: 0n, released: 1000n, periodEndsAt: 2000n },
    riskMode: [2, 4, health], strategiesOf: [id],
    feesAccrued: [0n, 0n], claimable: [0n, 0n], claimed: [0n, 0n], activeOrder: order, strategyNonce: 1n,
  };
  const client = {
    getChainId: async () => 31337,
    getCode: async () => "0x01",
    getBlock: async () => ({ number: 100n, timestamp: 1800n,
      hash: `0x${((++headers > 1 && options.reorg) ? "22" : "11").repeat(32)}` }),
    readContract: async (request: { functionName: string; blockNumber?: bigint }) => {
      calls.push(request);
      if (request.functionName === "quote" && options.quoteError) throw { data: options.quoteError };
      if (!(request.functionName in values)) throw new Error(`Unexpected read ${request.functionName}`);
      return values[request.functionName];
    },
  } as unknown as PublicClient;
  return { client, calls };
}

test("all policy and strategy reads share a confirmed block, and a paused risk mode stays visible", async () => {
  const { client, calls } = mockClient();
  const sdk = await createMandateClient(client, deployment);
  const policy = await sdk.readPolicy(policyId);
  assert.equal(policy.risk.mode, 2);
  assert.equal(policy.risk.reason, "MoveBeyondPause");
  assert.equal(policy.risk.health.spotX36, 6n);
  assert.deepEqual(policy.strategyIds, [id]);
  const strategy = await sdk.readStrategy(id);
  assert.equal(strategy.strategy.activeStrategyHash, hashAquaOrder(strategy.activeOrder));
  assert.equal(policy.source.blockNumber, 100n);
  assert.ok(calls.filter((call) => !["QUOTER", "ROUTER", "AQUA"].includes(call.functionName))
    .every((call) => call.blockNumber === 100n));
});

test("reorgs reject reads and failed quotes instead of attaching incorrect provenance", async () => {
  const cap = encodeErrorResult({ abi: mandateQuoterAbi, errorName: "NetSellCapReached", args: [1n, 1n, 1n] });
  const sdk = await createMandateClient(mockClient({ reorg: true }).client, deployment);
  await assert.rejects(sdk.readPolicy(policyId), /source block changed/);
  const strategies = await createMandateClient(mockClient({ reorg: true }).client, deployment);
  await assert.rejects(strategies.readStrategy(id), /source block changed/);
  const quote = await createMandateClient(mockClient({ reorg: true, quoteError: cap }).client, deployment);
  await assert.rejects(quote.quote(id, { taker: deployment.deployer, tokenIn: deployment.quote,
    tokenOut: deployment.base, amount: 1n, isExactIn: true }), /source block changed/);
});

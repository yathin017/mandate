import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import {
  anchorLauncherAbi, anchorPoolKey, buildAddStrategyCall, buildApproveRouterCall, buildCreatePolicyCall, buildCreateSafeCall,
  buildEnableModuleCall, buildLaunchAnchorCall, buildMintCall, buildSwapCall, createMandateClient, erc20Abi, mandateModuleAbi,
  mockTokenDeployment, parsePriceX36, readAnchorStatus, safeAbi, type PreparedCall,
} from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, maxUint256, pad, parseAbi, type Address, type Hex, type PublicClient } from "viem";

import { buildPolicy, decodePolicy, encodePolicy, type PolicyTerms } from "../src/issuer/policy.ts";
import { buildTerms, decodeTerms, encodeTerms, utcDate, type Terms, type TokenRef } from "../src/issuer/terms.ts";
import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

/**
 * The onboarding wizard end to end on the local fork, for a brand-new pair: a 2-of-2 Safe enables the module, two demo
 * tokens are minted, the launcher creates the pool and oracle, the team seeds the pool, the owners set the treasury
 * policy and then add a strategy from typed terms. Co-owners rebuild both calls from the shared link and must get the
 * same calldata. Once the pool is old enough and its history covers the policy's window, a taker buys from the
 * strategy through the SwapVM router. Every economic value here is a test input. Snapshotted and restored.
 */
const RPC = process.env.VITE_RPC_URL ?? "http://127.0.0.1:8547";
const deployment = getLocalForkDeployment();
const OWNER_1 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const OWNER_2 = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const MM = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const TAKER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
/** PoolModifyLiquidityTest on the fork (manifest `liquidityRouter`). */
const liquidityAbi = parseAbi([
  "function modifyLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params, bytes hookData) payable returns (int256)",
]);

const reachable = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
  body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' }).then((r) => r.ok).catch(() => false);

describe("onboarding: policy and strategy for a new pair", { skip: reachable ? false : "start the fork with `pnpm replay:serve`" }, () => {
  const publicClient = createPublicClient({ transport: http(RPC), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(RPC) });
  const rpc = (method: string, params: unknown[] = []) => publicClient.request({ method: method as never, params: params as never });
  const send = async (from: Address, data: Hex, to?: Address) => publicClient.waitForTransactionReceipt({
    hash: await wallet.sendTransaction({ account: from, data, chain: null, ...(to ? { to } : {}) }) });
  /** Both owners approve onchain, then owner 2 executes, as the Safe action panel does. */
  const execBySafe = async (safe: Address, call: PreparedCall) => {
    const nonce = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const hash = await publicClient.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });
    await send(OWNER_1, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }), safe);
    return send(OWNER_2, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction",
      args: execTxArgs(call.to, call.data, approvalSignatures([OWNER_1, OWNER_2])) }), safe);
  };
  const advanceTo = (timestamp: number | bigint) => rpc("evm_mine", [`0x${BigInt(timestamp).toString(16)}`]);
  const chainId = deployment.sourceChainId;
  let snapshot: string;
  let launcher: Address;

  before(async () => {
    snapshot = (await rpc("evm_snapshot")) as string;
    const artifact = JSON.parse(await readFile(new URL("../../../contracts/out/AnchorLauncher.sol/AnchorLauncher.json", import.meta.url), "utf8"));
    launcher = (await send(OWNER_1, encodeDeployData({ abi: anchorLauncherAbi, bytecode: artifact.bytecode.object,
      args: [getChainConfig(chainId).uniswapV4.poolManager, deployment.hook] }))).contractAddress!;
  });
  after(async () => {
    await rpc("evm_revert", [snapshot]);
  });

  test("owners set the policy and add a strategy; a taker fills once the market is trusted", async () => {
    // Safe + module.
    const create = buildCreateSafeCall(chainId, { owners: [OWNER_1, OWNER_2], threshold: 2, saltNonce: 909090n });
    const safe = getAddress(`0x${(await publicClient.call({ account: OWNER_1, to: create.to, data: create.data })).data!.slice(-40)}`);
    assert.equal((await send(OWNER_1, create.data, create.to)).status, "success");
    assert.equal((await execBySafe(safe, buildEnableModuleCall(chainId, safe, deployment.module))).status, "success");

    // Demo pair: the Safe gets its treasury, owner 1 the tokens it seeds the pool with.
    const deploy = async (name: string, symbol: string, decimals: number, safeAmount: bigint, lpAmount: bigint): Promise<TokenRef> => {
      const t = mockTokenDeployment(`Demo ${name}`, symbol, decimals);
      const address = (await send(OWNER_1, encodeDeployData({ abi: t.abi, bytecode: t.bytecode, args: t.args }))).contractAddress!;
      for (const [to, amount] of [[safe, safeAmount], [OWNER_1, lpAmount]] as const) {
        const mint = buildMintCall(chainId, address, to, amount * 10n ** BigInt(decimals));
        assert.equal((await send(OWNER_1, mint.data, mint.to)).status, "success");
      }
      return { address: getAddress(address), symbol, decimals };
    };
    const base = await deploy("Launch", "dLAUNCH", 18, 1_000_000n, 5_000_000n);
    const quote = await deploy("Dollar", "dUSD", 6, 10_000n, 2_000_000n);

    // Oracle launched, then the pool seeded (~1.6M dLAUNCH / ~630k dUSD full range at 0.40).
    const launch = buildLaunchAnchorCall(chainId, launcher, { base: base.address, quote: quote.address, initialPriceX36: parsePriceX36("0.40", 18, 6) });
    assert.equal((await send(OWNER_1, launch.data, launch.to)).status, "success");
    for (const token of [base.address, quote.address]) {
      await send(OWNER_1, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.liquidityRouter, maxUint256] }), token);
    }
    await send(OWNER_1, encodeFunctionData({ abi: liquidityAbi, functionName: "modifyLiquidity", args: [anchorPoolKey(deployment.hook, base.address, quote.address),
      { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 18n, salt: pad("0x0", { size: 32 }) }, "0x"] }), deployment.liquidityRouter);
    const status = await readAnchorStatus(publicClient, { chainId, launcher, base: base.address, quote: quote.address });
    assert.ok(status.anchor);
    assert.equal(status.ready, null, "no policy, no window to judge readiness by");
    assert.ok(status.trustedLiquidity < status.liquidity, "fresh liquidity is not trusted yet");

    // Owner 1 types the policy; owner 2 opens the shared link and rebuilds it.
    const now = (await publicClient.getBlock()).timestamp;
    const policyTerms: PolicyTerms = {
      allotment: "1000000", releaseStart: utcDate(now - 10n * 86_400n), releaseDays: "180", periodHours: "24", grossCap: "100000",
      netCap: "50000", quoteSpendCap: "5000", floor: "0.30", quoteDeviationPct: "3", impactPct: "3", twapMinutes: "30",
      shortTwapMinutes: "5", depthBandPct: "5", minPoolAgeHours: "1", minDepth: "10000", defensiveDepth: "20000",
      defensiveMovePct: "2", pauseMovePct: "10", defensiveVolatilityPct: "3", pauseVolatilityPct: "15", normalMaxFill: "10000",
      normalDepthSharePct: "50", normalMinSpreadPct: "0", normalBuybacks: "yes", defensiveMaxFill: "2000",
      defensiveDepthSharePct: "20", defensiveMinSpreadPct: "1.5", defensiveBuybacks: "no",
    };
    const policyCtx = { base, quote, oracle: status.anchor, holdings: { base: 10n ** 24n } };
    const policyCall = (t: PolicyTerms) => {
      const built = buildPolicy(t, policyCtx);
      assert.ok(!("error" in built), "error" in built ? built.error : "");
      return buildCreatePolicyCall(deployment, { base: base.address, quote: quote.address, config: built.config });
    };
    const policyTx = policyCall(policyTerms);
    assert.equal(policyCall(decodePolicy(encodePolicy(policyTerms)) as PolicyTerms).data, policyTx.data, "co-owner builds identical calldata");
    assert.equal((await execBySafe(safe, policyTx)).status, "success");
    const policyId = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activePolicyOf", args: [safe, base.address] });
    const policy = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [policyId] });
    assert.equal(policy.config.oracle.oracle, status.anchor);

    // Strategy terms, typed by owner 1 and rebuilt by owner 2. 25,000 base against 10,000 quote starts at the pool's 0.40.
    const holdings = {
      base: await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      quote: await publicClient.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
    };
    const terms: Terms = { mm: MM, kind: "marketMaking", spreadMinPct: "0.1", spreadMaxPct: "2", feeSharePct: "50", maxShippedBase: "1000000",
      maxShippedQuote: "10000", maxBuyPrice: "", spreadPct: "0.8", shippedBase: "25000", shippedQuote: "10000" };
    const ctx = { safe, owners: [OWNER_1, OWNER_2], base, quote, holdings, anchorPriceX36: status.spotPriceX36,
      policy: { floorPriceX36: policy.config.price.floorPriceX36, maxQuoteDeviationBps: policy.config.price.maxQuoteDeviationBps } };
    const toCall = (t: Terms) => {
      const built = buildTerms(t, ctx);
      assert.ok(!("error" in built), "error" in built ? built.error : "");
      return buildAddStrategyCall(deployment, { policyId, marketMaker: built.marketMaker, kind: built.kind, bounds: built.bounds, params: built.params });
    };
    const call = toCall(terms);
    assert.equal(toCall(decodeTerms(encodeTerms(terms)) as Terms).data, call.data, "co-owner builds identical calldata");
    // Refused before anyone approves: one unit more than the Safe holds, or a ratio far off the pool price.
    assert.ok("error" in buildTerms({ ...terms, shippedQuote: "10000.000001" }, ctx));
    assert.ok("error" in buildTerms({ ...terms, shippedBase: "1000000" }, ctx));
    assert.equal((await execBySafe(safe, call)).status, "success");

    const [id] = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });
    const strategy = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [id!] });
    assert.equal(strategy.mm, MM);
    assert.equal(strategy.status, 1);
    assert.notEqual(strategy.activeStrategyHash, `0x${"0".repeat(64)}`, "first order shipped");

    // A taker buys 100 base (the Safe sells). Refused while the pool is younger than the policy's minimum age.
    const sdk = await createMandateClient(publicClient, deployment);
    const buy = { taker: TAKER, tokenIn: quote.address, tokenOut: base.address, amount: 100n * 10n ** 18n, isExactIn: false };
    const early = await sdk.quote(id!, buy);
    assert.equal(early.ok, false, "no fills before the market is trusted");
    if (!early.ok) assert.equal(early.error.errorName, "RiskPaused");
    await advanceTo((await publicClient.getBlock()).timestamp + 3700n);
    const risk = await sdk.readPolicy(policyId);
    assert.equal(risk.risk.mode, 0, `risk ${risk.risk.reason}`);
    const quoted = await sdk.quote(id!, buy);
    assert.ok(quoted.ok, quoted.ok ? "" : quoted.error.message);
    // Exact-out at ~0.40 plus the 0.8% spread and 0.4% price impact: about 40.5 quote.
    assert.ok(quoted.amountIn > 40n * 10n ** 6n && quoted.amountIn < 41n * 10n ** 6n, `paid ${quoted.amountIn}`);

    const mint = buildMintCall(chainId, quote.address, TAKER, 1_000n * 10n ** 6n);
    await send(OWNER_1, mint.data, mint.to);
    const approve = buildApproveRouterCall(deployment, quote.address, quoted.amountIn);
    await send(TAKER, approve.data, approve.to);
    const order = await publicClient.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [id!] });
    const block = await publicClient.getBlock();
    const swap = buildSwapCall(deployment, { order, tokenIn: quote.address, tokenOut: base.address, amount: buy.amount,
      isExactIn: false, threshold: quoted.amountIn, deadline: block.timestamp + 600n });
    assert.equal((await send(TAKER, swap.data, swap.to)).status, "success");
    assert.equal(await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [TAKER] }), buy.amount);
    assert.equal(await publicClient.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      holdings.base - buy.amount, "tokens left the Safe only through the fill");
  });
});

/**
 * A complete demo treasury on Base mainnet, driven through the same SDK builders, Safe flow and API the web app uses:
 *
 *   setup     Owner 1 launches a token (TokenFactory), deploys a demo quote token, creates a 2-of-2 Safe with Owner 2,
 *             funds it, launches the pair's pool and market oracle and seeds liquidity. The owners enable the module and
 *             create the treasury policy.
 *   strategy  The market maker signs in and lists a profile; Owner 1 proposes a strategy; the market maker accepts by
 *             signing the exact terms; the owners add it through the Safe and link the proposal.
 *   trade     Owner 2, as a taker, buys from the strategy through the SwapVM router (once the policy's market checks
 *             pass: the pool must be older than the policy's minimum age).
 *   status    Prints what exists so far.
 *
 *   node --env-file=../../.env scripts/base-demo.ts <phase>        (from apps/web; the Base API must run on 8788)
 *
 * Keys come from DEMO_OWNER1_PRIVATE_KEY, DEMO_OWNER2_PRIVATE_KEY and DEMO_MM_PRIVATE_KEY and are never printed.
 * Every Safe action is the app's two-owner flow: Owner 1 approves the hash onchain, Owner 2 executes. Progress is
 * saved in .local/base-demo.json, so a re-run continues instead of repeating transactions. The economic values below
 * are this demo's choices, typed the way an issuer would type them in the app.
 *
 * Optional: DEMO_RPC_URL sends through another RPC (the indexer's may rate-limit large transactions), DEMO_STATE moves
 * the progress file (a fork rehearsal must not share the mainnet one), DEMO_API_URL / DEMO_WEB_ORIGIN point elsewhere.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { getDeployment, isLiveDeployment } from "@mandate/chains";
import {
  anchorPoolKey, buildAddStrategyCall, buildApproveRouterCall, buildCreatePolicyCall, buildCreateSafeCall, buildEnableModuleCall,
  buildLaunchAnchorCall, buildLaunchTokenCall, buildMintCall, buildSwapCall, createMandateClient, erc20Abi, mandateModuleAbi,
  mockTokenDeployment, predictLaunchedToken, readAnchorStatus, safeAbi, strategyTermsTypedData, termsFromJson, termsToJson,
  type PreparedCall,
} from "@mandate/sdk";
import {
  createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, maxUint256, pad, parseAbi,
  type Address, type Hash, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createSiweMessage } from "viem/siwe";

import { buildPolicy, type PolicyTerms } from "../src/issuer/policy.ts";
import { buildTerms, type Terms } from "../src/issuer/terms.ts";
import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

/** Progress file; DEMO_STATE points a rehearsal (e.g. on a local fork of Base) at its own file. */
const STATE = process.env.DEMO_STATE ? new URL(`file://${process.env.DEMO_STATE}`) : new URL("../../../.local/base-demo.json", import.meta.url);
const API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8788";
/** The web origin the Base API accepts sign-ins from (API_AUTH_ORIGINS). */
const ORIGIN = process.env.DEMO_WEB_ORIGIN ?? "http://localhost:5173";

const deployment = getDeployment(8453);
if (!isLiveDeployment(deployment) || !deployment.anchorLauncher || !deployment.tokenFactory) throw new Error("No Base deployment with launcher and factory");
const launcher: Address = deployment.anchorLauncher;
const factory: Address = deployment.tokenFactory;
const chainId = 8453;
const rpc = process.env.DEMO_RPC_URL ?? process.env.BASE_INDEXER_RPC_URL ?? process.env.BASE_RPC_URL;
if (!rpc) throw new Error("Set DEMO_RPC_URL, BASE_INDEXER_RPC_URL or BASE_RPC_URL");
const client = createPublicClient({ chain: base, transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) }) as PublicClient;

const key = (name: string) => {
  const value = process.env[name];
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Set ${name} in .env`);
  return privateKeyToAccount(value as Hex);
};
const owner1 = key("DEMO_OWNER1_PRIVATE_KEY");
const owner2 = key("DEMO_OWNER2_PRIVATE_KEY");
const mm = key("DEMO_MM_PRIVATE_KEY");
const wallets = Object.fromEntries([owner1, owner2, mm].map((a) => [a.address, createWalletClient({ account: a, chain: base, transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) })]));

/** PoolModifyLiquidityTest from the Base deployment (`liquidityRouter`): anyone may add liquidity through it. */
const liquidityAbi = parseAbi([
  "function modifyLiquidity((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, (int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt) params, bytes hookData) payable returns (int256)",
]);

type State = Partial<{ safe: Address; base: Address; quote: Address; oracle: Address; policyId: Hash; proposalId: string; strategyId: Hash; trade: Hash }>
  & { txs: Record<string, Hash> };
let state: State = { txs: {} };
const save = async () => {
  await mkdir(new URL("./", STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 2));
};

/** Sends one transaction and waits for it; skipped when this step already succeeded in an earlier run. */
async function send(step: string, from: Address, to: Address | undefined, data: Hex): Promise<Hash> {
  if (state.txs[step]) return state.txs[step]!;
  const hash = await wallets[from]!.sendTransaction({ to, data, chain: base, account: wallets[from]!.account! });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${step} reverted: ${hash}`);
  state.txs[step] = hash;
  await save();
  console.log(`  ${step}: https://basescan.org/tx/${hash}`);
  return hash;
}

/** The app's Safe flow: Owner 1 approves the transaction hash onchain, Owner 2 executes with both approvals. */
async function viaSafe(step: string, safe: Address, call: PreparedCall) {
  if (state.txs[`${step}:exec`]) return;
  const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const hash = await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });
  // Simulated first from the Safe, exactly like the app's pre-check: a refusal stops here with its reason.
  await client.call({ account: safe, to: call.to, data: call.data });
  await send(`${step}:approve@${nonce}`, owner1.address, safe, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }));
  await send(`${step}:exec`, owner2.address, safe,
    encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execTxArgs(call.to, call.data, approvalSignatures([owner1.address, owner2.address])) }));
}

async function signIn(account: typeof owner1): Promise<string> {
  const { nonce, statement } = (await (await fetch(`${API}/v1/auth/nonce`)).json()) as { nonce: string; statement: string };
  const message = createSiweMessage({ address: account.address, chainId, domain: new URL(ORIGIN).host, uri: ORIGIN, nonce, statement, version: "1", issuedAt: new Date() });
  const response = await fetch(`${API}/v1/auth/verify`, {
    method: "POST", headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

async function api(cookie: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`${API}${path}`, {
    method, headers: { cookie, origin: ORIGIN, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

const tokenRefs = () => ({
  base: { address: state.base!, symbol: "dORBIT", decimals: 18 },
  quote: { address: state.quote!, symbol: "dUSD", decimals: 6 },
});

async function setup() {
  // 1. Owner 1 creates the 2-of-2 treasury Safe.
  if (!state.safe) {
    const create = buildCreateSafeCall(chainId, { owners: [owner1.address, owner2.address], threshold: 2, saltNonce: 20261107n });
    const predicted = getAddress(`0x${(await client.call({ account: owner1.address, to: create.to, data: create.data })).data!.slice(-40)}`);
    await send("createSafe", owner1.address, create.to, create.data);
    state.safe = predicted;
    await save();
  }
  const safe = state.safe;

  // 2. Owner 1 launches the token through the TokenFactory (fixed supply, to Owner 1) and a demo quote token.
  if (!state.base) {
    const launch = { name: "Demo Orbit", symbol: "dORBIT", supply: 10_000_000n * 10n ** 18n, recipient: owner1.address, salt: pad("0x2026", { size: 32 }) };
    const predicted = await predictLaunchedToken(client, factory, owner1.address, launch);
    const call = buildLaunchTokenCall(chainId, factory, launch);
    await send("launchToken", owner1.address, call.to, call.data);
    state.base = predicted;
    await save();
  }
  if (!state.quote) {
    const usd = mockTokenDeployment("Demo Dollar", "dUSD", 6);
    await send("deployQuote", owner1.address, undefined, encodeDeployData({ abi: usd.abi, bytecode: usd.bytecode, args: usd.args }));
    const receipt = await client.getTransactionReceipt({ hash: state.txs.deployQuote! });
    state.quote = getAddress(receipt.contractAddress!);
    await save();
  }
  const { base: baseRef, quote: quoteRef } = tokenRefs();

  // 3. Fund the treasury: 1M dORBIT and 400k dUSD (demo amounts); Owner 1 keeps the rest of the supply for liquidity.
  await send("fundSafeBase", owner1.address, baseRef.address, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [safe, 1_000_000n * 10n ** 18n] }));
  for (const [step, to, amount] of [["mintSafeQuote", safe, 400_000n], ["mintLpQuote", owner1.address, 1_000_000n]] as const) {
    const mint = buildMintCall(chainId, quoteRef.address, to, amount * 10n ** 6n);
    await send(step, owner1.address, mint.to, mint.data);
  }

  // 4. The pair's Uniswap v4 pool and market oracle at 0.40 dUSD per dORBIT, then full-range liquidity (~1.6M / ~630k).
  const launchAnchor = buildLaunchAnchorCall(chainId, launcher, { base: baseRef.address, quote: quoteRef.address, initialPriceX36: 4n * 10n ** 23n });
  await send("launchAnchor", owner1.address, launchAnchor.to, launchAnchor.data);
  for (const token of [baseRef.address, quoteRef.address]) {
    await send(`approveLp:${token}`, owner1.address, token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [deployment.liquidityRouter, maxUint256] }));
  }
  await send("addLiquidity", owner1.address, deployment.liquidityRouter, encodeFunctionData({ abi: liquidityAbi, functionName: "modifyLiquidity",
    args: [anchorPoolKey(deployment.hook, baseRef.address, quoteRef.address), { tickLower: -887_220, tickUpper: 887_220, liquidityDelta: 10n ** 18n, salt: pad("0x0", { size: 32 }) }, "0x"] }));
  const status = await readAnchorStatus(client, { chainId, launcher: launcher, base: baseRef.address, quote: quoteRef.address });
  state.oracle = status.anchor!;
  await save();

  // 5. The owners enable the module and create the treasury policy (typed as an issuer would type it in the app).
  await viaSafe("enableModule", safe, buildEnableModuleCall(chainId, safe, deployment.module));
  if (!state.policyId) {
    const today = new Date().toISOString().slice(0, 10);
    const terms: PolicyTerms = {
      allotment: "1000000", releaseStart: today, releaseDays: "180", periodHours: "24", grossCap: "100000", netCap: "50000",
      quoteSpendCap: "20000", floor: "0.30", quoteDeviationPct: "3", impactPct: "3", twapMinutes: "30", shortTwapMinutes: "5",
      depthBandPct: "5", minPoolAgeHours: "1", minDepth: "10000", defensiveDepth: "25000", defensiveMovePct: "2",
      pauseMovePct: "10", defensiveVolatilityPct: "3", pauseVolatilityPct: "15", normalMaxFill: "10000",
      normalDepthSharePct: "20", normalMinSpreadPct: "0", normalBuybacks: "yes", defensiveMaxFill: "2000",
      defensiveDepthSharePct: "10", defensiveMinSpreadPct: "1.5", defensiveBuybacks: "no",
    };
    const built = buildPolicy(terms, { base: baseRef, quote: quoteRef, oracle: state.oracle });
    if ("error" in built) throw new Error(built.error);
    await viaSafe("createPolicy", safe, buildCreatePolicyCall(deployment, { base: baseRef.address, quote: quoteRef.address, config: built.config }));
    state.policyId = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activePolicyOf", args: [safe, baseRef.address] });
    await save();
  }
}

async function strategy() {
  const safe = state.safe!;
  const { base: baseRef, quote: quoteRef } = tokenRefs();
  const mmCookie = await signIn(mm);
  await api(mmCookie, "PUT", "/v1/mms/me", {
    displayName: "Demo Market Maker", bio: "Demo desk for the Mandate showcase on Base.", coverage: ["Base launches", "Demo pairs"], listed: true,
  });
  console.log(`  market maker listed: ${mm.address}`);

  const ownerCookie = await signIn(owner1);
  if (!state.proposalId) {
    const status = await readAnchorStatus(client, { chainId, launcher: launcher, base: baseRef.address, quote: quoteRef.address });
    const policy = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [state.policyId!] });
    // 250k dORBIT against 100k dUSD: the pool's 0.40.
    const terms: Terms = { mm: mm.address, kind: "marketMaking", spreadMinPct: "0.1", spreadMaxPct: "2", feeSharePct: "50", maxShippedBase: "1000000",
      maxShippedQuote: "400000", maxBuyPrice: "", spreadPct: "0.8", shippedBase: "250000", shippedQuote: "100000" };
    const built = buildTerms(terms, { safe, owners: [owner1.address, owner2.address], base: baseRef, quote: quoteRef, anchorPriceX36: status.spotPriceX36,
      policy: { floorPriceX36: policy.config.price.floorPriceX36, maxQuoteDeviationBps: policy.config.price.maxQuoteDeviationBps } });
    if ("error" in built) throw new Error(built.error);
    const sent = await api(ownerCookie, "POST", "/v1/proposals", {
      chainId, safe, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400, note: "Demo strategy for the Mandate showcase.", send: true,
      terms: termsToJson({ marketMaker: built.marketMaker, base: baseRef.address, quote: quoteRef.address, kind: built.kind, bounds: built.bounds, params: built.params }),
    });
    state.proposalId = sent.data.id;
    await save();
    console.log(`  proposal sent: ${state.proposalId}`);
  }

  // The market maker reads the proposal and signs its exact terms (EIP-712, no gas).
  const proposal = (await api(mmCookie, "GET", `/v1/proposals/${state.proposalId}`)).data;
  if (proposal.status === "sent") {
    const typed = strategyTermsTypedData(deployment, { proposalId: proposal.id, safe, terms: termsFromJson(proposal.terms), expiresAt: BigInt(proposal.expiresAt) });
    await api(mmCookie, "POST", `/v1/proposals/${proposal.id}/accept`, { signature: await mm.signTypedData(typed) });
    console.log("  market maker accepted");
  }

  // The owners add exactly the accepted terms under their policy, then link the proposal.
  const terms = termsFromJson(proposal.terms);
  await viaSafe("addStrategy", safe, buildAddStrategyCall(deployment, { policyId: state.policyId!, marketMaker: terms.marketMaker, kind: terms.kind, bounds: terms.bounds, params: terms.params }));
  if (!state.strategyId) {
    const ids = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [state.policyId!] });
    state.strategyId = ids.at(-1)!;
    await save();
    await api(ownerCookie, "POST", `/v1/proposals/${state.proposalId}/executed`, { strategyId: state.strategyId });
    console.log(`  strategy live: ${state.strategyId}`);
  }
}

async function trade() {
  const { base: baseRef, quote: quoteRef } = tokenRefs();
  const sdk = await createMandateClient(client, deployment);
  const policy = await sdk.readPolicy(state.policyId!);
  if (policy.risk.mode === 2) throw new Error(`The treasury is paused (${policy.risk.reason}); try again once the market checks pass`);
  // Owner 2 buys 1,000 dORBIT from the treasury, paying dUSD (minted by Owner 1, the demo token's owner).
  const buy = { taker: owner2.address, tokenIn: quoteRef.address, tokenOut: baseRef.address, amount: 1_000n * 10n ** 18n, isExactIn: false };
  const quoted = await sdk.quote(state.strategyId!, buy);
  if (!quoted.ok) throw new Error(quoted.error.message);
  const mint = buildMintCall(chainId, quoteRef.address, owner2.address, 1_000n * 10n ** 6n);
  await send("mintTaker", owner1.address, mint.to, mint.data);
  const approve = buildApproveRouterCall(deployment, quoteRef.address, quoted.amountIn);
  await send("approveTaker", owner2.address, approve.to, approve.data);
  const order = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [state.strategyId!] });
  const block = await client.getBlock();
  const swap = buildSwapCall(deployment, { order, tokenIn: quoteRef.address, tokenOut: baseRef.address, amount: buy.amount, isExactIn: false,
    threshold: (quoted.amountIn * 101n) / 100n, deadline: block.timestamp + 600n });
  state.trade = await send("trade", owner2.address, swap.to, swap.data);
}

async function status() {
  console.log(JSON.stringify({ ...state, roles: { owner1: owner1.address, owner2: owner2.address, mm: mm.address } }, null, 2));
  if (state.policyId) {
    const sdk = await createMandateClient(client, deployment);
    const p = await sdk.readPolicy(state.policyId);
    console.log(`risk mode ${p.risk.mode} (${p.risk.reason}), pool age ${p.risk.health.poolAge}s, trusted depth ${p.risk.health.trustedDepthBase}`);
  }
}

state = JSON.parse(await readFile(STATE, "utf8").catch(() => '{"txs":{}}'));
const phase = process.argv[2];
const phases: Record<string, () => Promise<void>> = { setup, strategy, trade, status };
if (!phase || !phases[phase]) throw new Error(`Usage: base-demo.ts <${Object.keys(phases).join("|")}>`);
console.log(`${phase} (Owner 1 ${owner1.address}, Owner 2 ${owner2.address}, MM ${mm.address})`);
await phases[phase]();
if (phase !== "status") console.log(`done: ${phase}`);

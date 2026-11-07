/**
 * Drives an existing treasury on Base (a Safe with a Mandate policy, e.g. one set up in the Launch page) through the
 * same SDK builders, Safe flow and API the web app uses:
 *
 *   status    The policy's risk mode, counters, strategies and the wallets' balances.
 *   strategy  The owner proposes a market-making strategy (suggested terms: inventory the Safe can back at the pool
 *             price) to the market maker, the market maker accepts by signing the exact terms, the owners add it
 *             through the Safe and link the proposal. Skipped when the policy already runs a live strategy.
 *   trades    The taker trades both sides of the live strategy through the SwapVM router: buys, and sells the
 *             treasury buys back (see TRADES). The owner mints the taker dUSD first when it owns the quote token.
 *
 *   TREASURY_SAFE=0x… TREASURY_BASE=0x… node --env-file=../../.env scripts/treasury-trades.ts <phase>
 *
 * Keys come from `${TREASURY_KEYS}_OWNER_PRIVATE_KEY` (and `_OWNER2_PRIVATE_KEY` for a 2-of-2 Safe), `_MM_PRIVATE_KEY`
 * and `_TAKER_PRIVATE_KEY` in .env; TREASURY_KEYS defaults to "EGM". Keys are never printed. Progress is saved in
 * .local/treasury-<safe>.json, so a re-run continues instead of repeating transactions. Needs the Base API on 8788
 * for the strategy phase (DEMO_API_URL, DEMO_WEB_ORIGIN and DEMO_RPC_URL override as in base-demo.ts).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";

import { getDeployment, isLiveDeployment } from "@mandate/chains";
import {
  buildAddStrategyCall, buildApproveRouterCall, buildMintCall, buildSwapCall, createMandateClient, erc20Abi, mandateModuleAbi,
  readAnchorStatus, safeAbi, strategyTermsTypedData, termsFromJson, termsToJson, type PreparedCall,
} from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, getAddress, http, isAddress, parseAbi, type Address, type Hash, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { createSiweMessage } from "viem/siwe";

import { suggestTerms } from "../src/issuer/explain.ts";
import { buildTerms } from "../src/issuer/terms.ts";
import { approvalSignatures, execTxArgs, safeTxArgs } from "../src/wallet/safeTx.ts";

const chainId = 8453;
const deployment = getDeployment(chainId);
if (!isLiveDeployment(deployment) || !deployment.anchorLauncher) throw new Error("No Base deployment with an anchor launcher");
const launcher: Address = deployment.anchorLauncher;

const safeArg = process.env.TREASURY_SAFE;
const baseArg = process.env.TREASURY_BASE;
if (!safeArg || !isAddress(safeArg) || !baseArg || !isAddress(baseArg)) throw new Error("Set TREASURY_SAFE and TREASURY_BASE to addresses");
const safe = getAddress(safeArg);
const baseToken = getAddress(baseArg);

const API = process.env.DEMO_API_URL ?? "http://127.0.0.1:8788";
const ORIGIN = process.env.DEMO_WEB_ORIGIN ?? "http://localhost:5173";
const rpc = process.env.DEMO_RPC_URL ?? "https://mainnet.base.org";
const client = createPublicClient({ chain: base, transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) }) as PublicClient;
const STATE = new URL(`../../../.local/treasury-${safe.toLowerCase()}.json`, import.meta.url);

const prefix = process.env.TREASURY_KEYS ?? "EGM";
const key = (name: string, optional = false) => {
  const value = process.env[`${prefix}_${name}_PRIVATE_KEY`];
  if (!value && optional) return undefined;
  if (!value || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error(`Set ${prefix}_${name}_PRIVATE_KEY in .env`);
  return privateKeyToAccount(value as Hex);
};
const owner = key("OWNER")!;
const owner2 = key("OWNER2", true);
const mm = key("MM")!;
const taker = key("TAKER")!;
const wallets = Object.fromEntries(
  [owner, owner2, mm, taker].filter((a) => a !== undefined).map((a) => [a!.address, createWalletClient({ account: a!, chain: base, transport: http(rpc, { retryCount: 5, retryDelay: 1500 }) })]),
);

type State = { txs: Record<string, Hash>; proposalId?: string; strategyId?: Hash };
let state: State = { txs: {} };
const save = async () => {
  await mkdir(new URL("./", STATE), { recursive: true });
  await writeFile(STATE, JSON.stringify(state, null, 2));
};

/** Sends one transaction and waits for it; skipped when this step already succeeded in an earlier run. */
async function send(step: string, from: Address, to: Address, data: Hex): Promise<Hash> {
  if (state.txs[step]) return state.txs[step]!;
  const wallet = wallets[from]!;
  const hash = await wallet.sendTransaction({ to, data, chain: base, account: wallet.account! });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1 });
  if (receipt.status !== "success") throw new Error(`${step} reverted: ${hash}`);
  state.txs[step] = hash;
  await save();
  console.log(`  ${step}: https://basescan.org/tx/${hash}`);
  return hash;
}

/**
 * The app's Safe flow. A 1-of-1 Safe: the owner executes with its own approval (msg.sender counts as signed). A
 * 2-of-2: the first owner approves the hash onchain and the second executes with both approvals.
 */
async function viaSafe(step: string, call: PreparedCall) {
  if (state.txs[`${step}:exec`]) return;
  const threshold = await client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" });
  // Simulated first from the Safe, like the app's pre-check: a refusal stops here with its reason.
  await client.call({ account: safe, to: call.to, data: call.data });
  if (threshold === 1n) {
    await send(`${step}:exec`, owner.address, safe,
      encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execTxArgs(call.to, call.data, approvalSignatures([owner.address])) }));
    return;
  }
  if (!owner2) throw new Error(`This Safe needs ${threshold} approvals: set ${prefix}_OWNER2_PRIVATE_KEY`);
  const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
  const hash = await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) });
  await send(`${step}:approve@${nonce}`, owner.address, safe, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }));
  await send(`${step}:exec`, owner2.address, safe,
    encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: execTxArgs(call.to, call.data, approvalSignatures([owner.address, owner2.address])) }));
}

async function signIn(account: typeof owner): Promise<string> {
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

const tokenAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function owner() view returns (address)"]);

/** The treasury as the chain has it: policy, pair and live strategy. */
async function treasury() {
  const policyId = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activePolicyOf", args: [safe, baseToken] });
  if (/^0x0{64}$/.test(policyId)) throw new Error("This Safe has no treasury policy for that token");
  const policy = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [policyId] });
  const ref = async (address: Address) => ({
    address,
    symbol: await client.readContract({ address, abi: tokenAbi, functionName: "symbol" }),
    decimals: Number(await client.readContract({ address, abi: tokenAbi, functionName: "decimals" })),
  });
  const ids = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });
  const strategies = await Promise.all(ids.map(async (id) => ({ id, ...(await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getStrategy", args: [id] })) })));
  const live = strategies.filter((s) => Number(s.status) === 1);
  return { policyId, policy, base: await ref(baseToken), quote: await ref(getAddress(policy.quote)), live };
}

const amount = (raw: bigint, decimals: number, digits = 2) => (Number(raw) / 10 ** decimals).toLocaleString("en", { maximumFractionDigits: digits });

async function status() {
  const t = await treasury();
  const sdk = await createMandateClient(client, deployment);
  const p = await sdk.readPolicy(t.policyId);
  console.log(`  policy ${t.policyId}: risk ${p.risk.mode} (${p.risk.reason}), trusted depth ${amount(p.risk.health.trustedDepthBase, t.base.decimals)} ${t.base.symbol}`);
  console.log(`  this period: gross ${amount(p.counters.grossSold, t.base.decimals)}, net ${amount(p.counters.netSold, t.base.decimals)} ${t.base.symbol}, buybacks ${amount(p.counters.quoteSpent, t.quote.decimals)} ${t.quote.symbol}; released ${amount(p.counters.released, t.base.decimals)}`);
  for (const s of t.live) console.log(`  live strategy ${s.id} (market maker ${s.mm})`);
  for (const [role, a] of [["owner", owner.address], ["market maker", mm.address], ["taker", taker.address]] as const) {
    const [eth, b, q] = await Promise.all([
      client.getBalance({ address: a }),
      client.readContract({ address: t.base.address, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
      client.readContract({ address: t.quote.address, abi: erc20Abi, functionName: "balanceOf", args: [a] }),
    ]);
    console.log(`  ${role} ${a}: ${amount(eth, 18, 6)} ETH, ${amount(b, t.base.decimals)} ${t.base.symbol}, ${amount(q, t.quote.decimals)} ${t.quote.symbol}`);
  }
}

async function strategy() {
  const t = await treasury();
  if (t.live.length) {
    console.log(`  already live: ${t.live.map((s) => s.id).join(", ")}`);
    return;
  }
  const ownerCookie = await signIn(owner);
  const mmCookie = await signIn(mm);
  if (!state.proposalId) {
    const anchor = await readAnchorStatus(client, { chainId, launcher, base: t.base.address, quote: t.quote.address });
    const [heldBase, heldQuote] = await Promise.all([
      client.readContract({ address: t.base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
      client.readContract({ address: t.quote.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
    ]);
    const owners = await client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    const terms = suggestTerms({ base: t.base, quote: t.quote, mm: mm.address, anchorPriceX36: anchor.spotPriceX36, holdings: { base: heldBase, quote: heldQuote } });
    const built = buildTerms(terms, { safe, owners: [...owners], base: t.base, quote: t.quote, anchorPriceX36: anchor.spotPriceX36, holdings: { base: heldBase, quote: heldQuote },
      policy: { floorPriceX36: t.policy.config.price.floorPriceX36, maxQuoteDeviationBps: t.policy.config.price.maxQuoteDeviationBps } });
    if ("error" in built) throw new Error(built.error);
    const sent = await api(ownerCookie, "POST", "/v1/proposals", {
      chainId, safe, expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400, send: true,
      note: `Market making for ${t.base.symbol}/${t.quote.symbol} under our treasury policy.`,
      terms: termsToJson({ marketMaker: built.marketMaker, base: t.base.address, quote: t.quote.address, kind: built.kind, bounds: built.bounds, params: built.params }),
    });
    state.proposalId = sent.data.id;
    await save();
    console.log(`  proposal sent: ${state.proposalId} (${terms.shippedBase} ${t.base.symbol} + ${terms.shippedQuote} ${t.quote.symbol}, spread ${terms.spreadPct}%)`);
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
  await viaSafe("addStrategy", buildAddStrategyCall(deployment, { policyId: t.policyId, marketMaker: terms.marketMaker, kind: terms.kind, bounds: terms.bounds, params: terms.params }));
  const ids = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [t.policyId] });
  state.strategyId = ids.at(-1)!;
  await save();
  await api(ownerCookie, "POST", `/v1/proposals/${state.proposalId}/executed`, { strategyId: state.strategyId });
  console.log(`  strategy live: ${state.strategyId}`);
}

/**
 * Amounts in base tokens. Each fill stays near 1% of a typical order's inventory: the order prices along its own
 * balances, so a fill of a fraction f moves its price by about 2f, and the policy caps impact (3% in the suggested
 * policy). Each sell back is a treasury buyback.
 */
const TRADES: { side: "buy" | "sell"; amount: bigint }[] = [
  { side: "buy", amount: 1_000n }, { side: "sell", amount: 500n }, { side: "buy", amount: 1_500n },
  { side: "sell", amount: 800n }, { side: "buy", amount: 800n }, { side: "sell", amount: 1_000n },
];

/** First step name not yet completed: `name`, then `name#2`, … so the phase can run again. */
function round(name: string, done: (n: string) => boolean): string {
  if (!done(name)) return name;
  let n = 2;
  while (done(`${name}#${n}`)) n++;
  return `${name}#${n}`;
}

async function trades() {
  const t = await treasury();
  const live = t.live.at(-1);
  if (!live) throw new Error("No live strategy: run the strategy phase first");
  const sdk = await createMandateClient(client, deployment);
  const batch = round("trades", (n) => !!state.txs[`${n}:${TRADES.length - 1}:swap`]);
  const one = (d: number) => 10n ** BigInt(d);

  // Taker funding: enough quote for every buy at up to 1.1× the pool price, minted by the quote token's owner.
  const quoteOwner = await client.readContract({ address: t.quote.address, abi: tokenAbi, functionName: "owner" }).catch(() => null);
  const held = await client.readContract({ address: t.quote.address, abi: erc20Abi, functionName: "balanceOf", args: [taker.address] });
  const anchor = await readAnchorStatus(client, { chainId, launcher, base: t.base.address, quote: t.quote.address });
  const need = (TRADES.filter((x) => x.side === "buy").reduce((s, x) => s + x.amount, 0n) * one(t.base.decimals) * anchor.spotPriceX36 * 11n) / (10n * 10n ** 36n);
  if (held < need) {
    if (!quoteOwner || getAddress(quoteOwner) !== owner.address) throw new Error(`The taker needs ${amount(need, t.quote.decimals)} ${t.quote.symbol} and the owner cannot mint it`);
    const mint = buildMintCall(chainId, t.quote.address, taker.address, need - held);
    await send(`${batch}:mint`, owner.address, mint.to, mint.data);
  }

  for (const [i, x] of TRADES.entries()) {
    const step = `${batch}:${i}`;
    if (state.txs[`${step}:swap`]) continue;
    const policy = await sdk.readPolicy(t.policyId);
    if (policy.risk.mode === 2) throw new Error(`The treasury is paused (${policy.risk.reason}); try again once the market checks pass`);
    const [tokenIn, tokenOut] = x.side === "buy" ? [t.quote.address, t.base.address] : [t.base.address, t.quote.address];
    const request = { taker: taker.address, tokenIn, tokenOut, amount: x.amount * one(t.base.decimals), isExactIn: x.side === "sell" };
    const quoted = await sdk.quote(live.id, request);
    if (!quoted.ok) throw new Error(`${x.side} ${x.amount} ${t.base.symbol}: ${quoted.error.message}`);
    const approve = buildApproveRouterCall(deployment, tokenIn, x.side === "buy" ? (quoted.amountIn * 101n) / 100n : request.amount);
    await send(`${step}:approve`, taker.address, approve.to, approve.data);
    const order = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [live.id] });
    const block = await client.getBlock();
    // Exact out: pay at most 1% over the quote; exact in: receive at least 99% of it.
    const threshold = x.side === "buy" ? (quoted.amountIn * 101n) / 100n : (quoted.amountOut * 99n) / 100n;
    const swap = buildSwapCall(deployment, { order, tokenIn, tokenOut, amount: request.amount, isExactIn: request.isExactIn, threshold, deadline: block.timestamp + 600n });
    await send(`${step}:swap`, taker.address, swap.to, swap.data);
    console.log(`    ${x.side} ${x.amount} ${t.base.symbol} for ${amount(x.side === "buy" ? quoted.amountIn : quoted.amountOut, t.quote.decimals)} ${t.quote.symbol}`);
  }
}

state = JSON.parse(await readFile(STATE, "utf8").catch(() => '{"txs":{}}'));
const phase = process.argv[2];
const phases: Record<string, () => Promise<void>> = { status, strategy, trades };
if (!phase || !phases[phase]) throw new Error(`Usage: treasury-trades.ts <${Object.keys(phases).join("|")}>`);
console.log(`${phase} · Safe ${safe} · token ${baseToken}`);
await phases[phase]();
if (phase !== "status") console.log(`done: ${phase}`);

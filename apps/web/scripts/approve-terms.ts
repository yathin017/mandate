/**
 * Co-owner approval from a shared onboarding link, for an owner whose key lives in a local .env instead of a browser
 * wallet. Rebuilds the Safe call exactly as the wizard does (same terms modules, same chain reads), prints every value,
 * and with --broadcast records the owner's `approveHash` for it on the Safe. The link carries either a treasury policy
 * (`policy=`, creating it) or strategy terms (`terms=`, adding the strategy under the Safe's live policy).
 *
 *   node scripts/approve-terms.ts --rpc <url> --link '<wizard url>' [--nonce <n>] [--key-env <VAR>] [--broadcast]
 *
 * --nonce defaults to the Safe's current nonce; pass a later one to pre-approve behind a pending transaction.
 * The private key is read from the named environment variable (never from the command line) and never printed.
 */
import { parseArgs } from "node:util";

import { getDeployment, isLiveDeployment } from "@mandate/chains";
import { buildAddStrategyCall, buildCreatePolicyCall, mandateModuleAbi, readAnchorStatus, readTokenInfo, safeAbi, erc20Abi, type PreparedCall } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { formatBps, formatDuration, formatPrice, formatUnits } from "../src/lib/format.ts";
import { buildPolicy, decodePolicy, POLICY_KEYS, type PolicyTerms } from "../src/issuer/policy.ts";
import { buildTerms, decodeTerms, TERM_KEYS, utcDate, type Terms, type TokenRef } from "../src/issuer/terms.ts";
import { safeTxArgs } from "../src/wallet/safeTx.ts";

const { values } = parseArgs({
  options: {
    rpc: { type: "string" },
    link: { type: "string" },
    nonce: { type: "string" },
    "key-env": { type: "string", default: "BASE_DEPLOYER_PRIVATE_KEY" },
    broadcast: { type: "boolean", default: false },
  },
});
if (!values.rpc || !values.link) throw new Error("Usage: --rpc <url> --link '<wizard url>' [--nonce <n>] [--key-env <VAR>] [--broadcast]");

const params = new URL(values.link).searchParams;
const [safe, baseAddress, quoteAddress] = ["safe", "base", "quote"].map((k) => params.get(k));
if (!safe || !isAddress(safe) || !baseAddress || !isAddress(baseAddress) || !quoteAddress || !isAddress(quoteAddress))
  throw new Error("The link must carry safe, base and quote addresses");

const client = createPublicClient({ transport: http(values.rpc) }) as PublicClient;
const deployment = getDeployment(await client.getChainId());
if (!isLiveDeployment(deployment) || !deployment.anchorLauncher) throw new Error("This chain has no registered AnchorLauncher");

const token = async (address: Address): Promise<TokenRef> => {
  const info = await readTokenInfo(client, address);
  if (!info.ok) throw new Error(`${address} is not a usable ERC20: ${info.reason}`);
  return { address: info.address, symbol: info.symbol, decimals: info.decimals };
};
const [base, quote] = await Promise.all([token(baseAddress), token(quoteAddress)]);
const anchorStatus = await readAnchorStatus(client, { chainId: deployment.sourceChainId, launcher: deployment.anchorLauncher, base: base.address, quote: quote.address });
if (!anchorStatus.anchor) throw new Error("The pair has no anchor yet; launch it from the wizard first");
const [owners, currentNonce, baseHeld] = await Promise.all([
  client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
  client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  client.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
]);
const amount = (raw: bigint, t: TokenRef) => `${formatUnits(raw, t.decimals, t.decimals)} ${t.symbol}`;
const price = (x36: bigint) => `${formatPrice(x36, base.decimals, quote.decimals, 6)} ${quote.symbol}`;

let call: PreparedCall;
let rows: Record<string, string>;
let warnings: string[];
if (params.get("terms")) {
  // Strategy terms: added under the Safe's live policy for the pair.
  const shared = decodeTerms(params.get("terms"));
  const missing = TERM_KEYS.filter((k) => shared?.[k] === undefined);
  if (missing.length > 0) throw new Error(`The link's terms are missing: ${missing.join(", ")}`);
  const policyId = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "activePolicyOf", args: [safe, base.address] });
  if (/^0x0{64}$/.test(policyId)) throw new Error("The Safe has no live policy for this token; approve the policy first");
  const policy = await client.readContract({ address: deployment.module, abi: mandateModuleAbi, functionName: "getPolicy", args: [policyId] });
  const quoteHeld = await client.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
  const built = buildTerms(shared as Terms, {
    safe, owners, base, quote, holdings: { base: baseHeld, quote: quoteHeld }, anchorPriceX36: anchorStatus.spotPriceX36,
    policy: { floorPriceX36: policy.config.price.floorPriceX36, maxQuoteDeviationBps: policy.config.price.maxQuoteDeviationBps },
  });
  if ("error" in built) throw new Error(built.error);
  call = buildAddStrategyCall(deployment, { policyId, marketMaker: built.marketMaker, kind: built.kind, bounds: built.bounds, params: built.params });
  const b = built.bounds;
  rows = {
    "Action": `Add a ${built.kind === 1 ? "buyback" : "market-making"} strategy under policy ${policyId}`,
    "Market maker": built.marketMaker,
    "Spread": `${formatBps(built.params.spreadBps)} (range ${formatBps(b.spreadBpsMin)} - ${formatBps(b.spreadBpsMax)})`,
    "MM fee share": formatBps(b.mmFeeShareBps),
    "Most inventory": `${amount(b.maxShippedBase, base)} and ${amount(b.maxShippedQuote, quote)}`,
    ...(built.kind === 1 ? { "Highest buyback price": price(b.maxBuyPriceX36) } : {}),
    "Starting price": `${price((built.params.shippedQuote * 10n ** 36n) / built.params.shippedBase)} (pool ${price(anchorStatus.spotPriceX36)})`,
    "Initial inventory": `${amount(built.params.shippedBase, base)} and ${amount(built.params.shippedQuote, quote)}`,
  };
  warnings = built.warnings;
} else if (params.get("policy")) {
  const shared = decodePolicy(params.get("policy"));
  const missing = POLICY_KEYS.filter((k) => shared?.[k] === undefined);
  if (missing.length > 0) throw new Error(`The link's policy is missing: ${missing.join(", ")}`);
  const built = buildPolicy(shared as PolicyTerms, { base, quote, oracle: anchorStatus.anchor, holdings: { base: baseHeld } });
  if ("error" in built) throw new Error(built.error);
  call = buildCreatePolicyCall(deployment, { base: base.address, quote: quote.address, config: built.config });
  const c = built.config;
  const period = formatDuration(Number(c.period.periodLength));
  rows = {
    "Action": "Create the treasury policy",
    "Oracle": c.oracle.oracle,
    "Release": `${amount(c.release.allotment, base)} from ${utcDate(c.release.releaseStart)} over ${c.release.releaseDuration / 86_400n} days`,
    "Limits per period": `${period}: gross ${amount(c.period.grossSellCap, base)}, net ${amount(c.period.netSellCap, base)}, buybacks ${amount(c.period.quoteSpendCap, quote)}`,
    "Price rules": `floor ${c.price.floorPriceX36 === 0n ? "none" : price(c.price.floorPriceX36)}, quote tolerance ${formatBps(c.price.maxQuoteDeviationBps)}, impact ${formatBps(c.price.maxImpactBps)}`,
    "Oracle reading": `TWAP ${formatDuration(c.oracle.twapWindow)}, short ${formatDuration(c.oracle.shortWindow)}, depth band ${formatBps(c.oracle.depthBandBps)}`,
    "Pause when": `move > ${formatBps(c.oracle.pauseMoveBps)}, volatility > ${formatBps(c.oracle.pauseVolatilityBps)}, depth < ${amount(c.oracle.minTrustedDepth, base)}, pool < ${formatDuration(c.oracle.minPoolAge)}`,
    "Defensive when": `move > ${formatBps(c.oracle.defensiveMoveBps)}, volatility > ${formatBps(c.oracle.defensiveVolatilityBps)}, depth < ${amount(c.oracle.defensiveDepth, base)}`,
    "Normal limits": `fill ≤ ${amount(c.normal.maxFillBase, base)} and ${formatBps(c.normal.maxFillDepthBps)} of depth, spread ≥ ${formatBps(c.normal.minSpreadBps)}, buybacks ${c.normal.buybacksAllowed}`,
    "Defensive limits": `fill ≤ ${amount(c.defensive.maxFillBase, base)} and ${formatBps(c.defensive.maxFillDepthBps)} of depth, spread ≥ ${formatBps(c.defensive.minSpreadBps)}, buybacks ${c.defensive.buybacksAllowed}`,
  };
  warnings = built.warnings;
} else {
  throw new Error("The link carries neither a policy nor strategy terms");
}

const nonce = values.nonce === undefined ? currentNonce : BigInt(values.nonce);
if (nonce < currentNonce) throw new Error(`Nonce ${nonce} is already used (Safe nonce ${currentNonce})`);
const safeTxHash = (await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) })) as Hex;
console.table({ "Safe": safe, "Pair": `${base.symbol} ${base.address} / ${quote.symbol} ${quote.address}`, ...rows, "Safe nonce": `${nonce} (current ${currentNonce})`, "Safe tx hash": safeTxHash });
for (const warning of warnings) console.warn(`Warning: ${warning}`);

if (!values.broadcast) {
  console.log("Dry run: nothing sent. Add --broadcast to approve this hash.");
} else {
  const key = process.env[values["key-env"]!];
  if (!key) throw new Error(`Set ${values["key-env"]} in the environment`);
  const account = privateKeyToAccount(key as Hex);
  if (!owners.some((o) => o.toLowerCase() === account.address.toLowerCase())) throw new Error(`${account.address} is not an owner of ${safe}`);
  const wallet = createWalletClient({ account, transport: http(values.rpc) });
  const hash = await wallet.sendTransaction({
    chain: null, to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [safeTxHash] }),
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  console.log(`approveHash ${receipt.status} by ${account.address}: ${hash}`);
}

/**
 * Co-owner approval from a shared onboarding link, for an owner whose key lives in a local .env instead of a browser
 * wallet. Rebuilds the createMandate call exactly as the wizard does (same terms module, same chain reads), prints
 * every term, and with --broadcast records the owner's `approveHash` for it on the Safe.
 *
 *   node scripts/approve-terms.ts --rpc <url> --link '<wizard url>' [--nonce <n>] [--key-env <VAR>] [--broadcast]
 *
 * --nonce defaults to the Safe's current nonce; pass a later one to pre-approve behind a pending transaction.
 * The private key is read from the named environment variable (never from the command line) and never printed.
 */
import { parseArgs } from "node:util";

import { getDeployment, isLiveDeployment } from "@mandate/chains";
import { buildCreateMandateCall, readAnchorStatus, readTokenInfo, safeAbi, erc20Abi } from "@mandate/sdk";
import { createPublicClient, createWalletClient, encodeFunctionData, http, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { formatBps, formatPrice, formatUnits } from "../src/lib/format.ts";
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
const shared = decodeTerms(params.get("terms"));
const missing = TERM_KEYS.filter((k) => shared?.[k] === undefined);
if (missing.length > 0) throw new Error(`The link's terms are missing: ${missing.join(", ")}`);
const terms = shared as Terms;

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
const [owners, currentNonce, baseHeld, quoteHeld] = await Promise.all([
  client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
  client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
  client.readContract({ address: base.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
  client.readContract({ address: quote.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
]);

const built = buildTerms(terms, {
  safe, owners, base, quote, anchor: anchorStatus.anchor, holdings: { base: baseHeld, quote: quoteHeld }, anchorPriceX36: anchorStatus.spotPriceX36,
});
if ("error" in built) throw new Error(built.error);
const call = buildCreateMandateCall(deployment, { marketMaker: built.marketMaker, base: base.address, quote: quote.address, bounds: built.bounds, params: built.params });
const nonce = values.nonce === undefined ? currentNonce : BigInt(values.nonce);
if (nonce < currentNonce) throw new Error(`Nonce ${nonce} is already used (Safe nonce ${currentNonce})`);
const safeTxHash = (await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: safeTxArgs(call.to, call.data, nonce) })) as Hex;

const b = built.bounds;
const amount = (raw: bigint, t: TokenRef) => `${formatUnits(raw, t.decimals, t.decimals)} ${t.symbol}`;
console.table({
  "Safe": safe,
  "Market maker": built.marketMaker,
  "Pair": `${base.symbol} ${base.address} / ${quote.symbol} ${quote.address}`,
  "Anchor": `${anchorStatus.anchor} (${anchorStatus.ready ? "ready" : "collecting history"})`,
  "Allotment": amount(b.allotment, base),
  "Release": `${utcDate(b.releaseStart)} + ${b.releaseDuration / 86_400n} days`,
  "Daily sell limit": amount(b.maxEpochCap, base),
  "Price floor": `${formatPrice(b.floorPriceX36, base.decimals, quote.decimals, 6)} ${quote.symbol}`,
  "Starting price": `${formatPrice((built.params.shippedQuote * 10n ** 36n) / built.params.shippedBase, base.decimals, quote.decimals, 6)} ${quote.symbol} (pool ${formatPrice(anchorStatus.spotPriceX36, base.decimals, quote.decimals, 6)})`,
  "Anchor tolerance": formatBps(b.maxAnchorDeviationBps),
  "Spread": `${formatBps(built.params.spreadBps)} (range ${formatBps(b.spreadBpsMin)} - ${formatBps(b.spreadBpsMax)})`,
  "MM fee share": formatBps(b.mmFeeShareBps),
  "Initial inventory": amount(built.params.shippedBase, base),
  "Buyback inventory": amount(built.params.shippedQuote, quote),
  "Safe nonce": `${nonce} (current ${currentNonce})`,
  "Safe tx hash": safeTxHash,
});
for (const warning of built.warnings) console.warn(`Warning: ${warning}`);

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

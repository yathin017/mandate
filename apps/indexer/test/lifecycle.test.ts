import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";

import { getChainConfig, getLocalForkDeployment } from "@mandate/chains";
import {
  anchorLauncherAbi, buildApproveRouterCall, buildCreateMandateCall, buildCreateSafeCall, buildEnableModuleCall,
  buildLaunchAnchorCall, buildLaunchTokenCall, buildMintCall, buildSwapCall, mandateModuleAbi, mandateTermsTypedData,
  mockTokenDeployment, parsePriceX36, predictLaunchedToken, readAnchorStatus, safeAbi, termsFromJson, termsToJson,
  tokenFactoryAbi, type MandateTerms, type PreparedCall,
} from "@mandate/sdk";
import {
  concat, createPublicClient, createWalletClient, encodeDeployData, encodeFunctionData, getAddress, http, pad, toHex,
  zeroAddress, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import { keys } from "../src/cache/keys.ts";
import { Prober } from "../src/score/prober.ts";
import { indexDemoChain, rpc, signIn, skip, TEST_WEB_ORIGIN, testConfig } from "./helpers.ts";

/**
 * The whole platform on the local fork, as a new project would use it: launch a token through the TokenFactory
 * into a new 2-of-2 Safe, enable the module, launch the anchor, list a market maker, propose, have the market maker
 * sign the exact terms, execute through the Safe, link the proposal, trade, and read the issuer's and market maker's
 * analytics and the score. Contracts, API and indexer are the real ones; wallets are Anvil's public development
 * keys. The fork is snapshotted and restored, and the test database is wiped.
 */
const owner1 = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const owner2 = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mm = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const TAKER = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as Address;
const fork = getLocalForkDeployment();
const chainId = fork.sourceChainId;

type Json = Record<string, any>;

describe("platform lifecycle: launch → marketplace → proposal → mandate → trade → analytics", { skip }, () => {
  const rpcUrl = testConfig().INDEXER_RPC_URL;
  const client = createPublicClient({ transport: http(rpcUrl), cacheTime: 0 }) as PublicClient;
  const wallet = createWalletClient({ transport: http(rpcUrl) });
  const send = async (from: Address, data: Hex, to?: Address) => {
    const receipt = await client.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, data, chain: null, ...(to ? { to } : {}) }) });
    assert.equal(receipt.status, "success");
    return receipt;
  };
  /** Owner 1 approves onchain, owner 2 executes with both approvals (v = 1 signatures, sorted by owner). */
  const viaSafe = async (safe: Address, call: PreparedCall) => {
    const nonce = await client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const args = [call.to, 0n, call.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
    const hash = await client.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [...args, nonce] });
    await send(owner1.address, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }), safe);
    const signatures = concat(
      [owner1.address, owner2.address]
        .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
        .map((o) => concat([pad(o, { size: 32 }), pad("0x0", { size: 32 }), toHex(1, { size: 1 })])),
    );
    return send(owner2.address, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...args, signatures] }), safe);
  };
  const artifact = async (name: string) =>
    JSON.parse(await readFile(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8")).bytecode.object as Hex;

  let snapshot: string;
  let factory: Address;
  let launcher: Address;
  let safe: Address;
  let base: Address;
  let quote: Address;
  let anchor: Address;
  let config: ReturnType<typeof testConfig>;
  let indexed: Awaited<ReturnType<typeof indexDemoChain>>;
  let cache: Cache;
  let app: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  const call = async (who: keyof typeof cookies | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: TEST_WEB_ORIGIN };
    if (who) headers.cookie = cookies[who]!;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
  };
  /** Mines one block `seconds` after the current head (explicit timestamps; evm_increaseTime is not relied on). */
  const advance = async (seconds: number) => {
    const now = (await client.getBlock()).timestamp;
    await rpc(rpcUrl, "evm_mine", [`0x${(now + BigInt(seconds)).toString(16)}`]);
  };
  /** Indexes new blocks and moves the API's head to them. */
  const catchUp = async () => {
    while (await indexed.indexer.step()) {
      /* index to head */
    }
    const head = await client.getBlock();
    await cache.setHead(config.INDEXER_CHAIN_ID, { number: head.number.toString(), hash: head.hash });
  };

  before(async () => {
    snapshot = await rpc<string>(rpcUrl, "evm_snapshot");
    factory = (await send(owner1.address, encodeDeployData({ abi: tokenFactoryAbi, bytecode: await artifact("TokenFactory") }))).contractAddress!;
    launcher = (await send(owner1.address, encodeDeployData({ abi: anchorLauncherAbi, bytecode: await artifact("AnchorLauncher"),
      args: [getChainConfig(chainId).uniswapV4.poolManager, fork.hook] }))).contractAddress!;
  });
  after(async () => {
    await rpc(rpcUrl, "evm_revert", [snapshot]);
    if (cache) {
      await cache.delete(keys.head(config.INDEXER_CHAIN_ID));
      await cache.close();
    }
    await indexed?.close();
  });

  test("1. a new project sets up onchain: Safe, launched token, module, anchor", async () => {
    const create = buildCreateSafeCall(chainId, { owners: [owner1.address, owner2.address], threshold: 2, saltNonce: 77_777n });
    safe = getAddress(`0x${(await client.call({ account: owner1.address, to: create.to, data: create.data })).data!.slice(-40)}`);
    await send(owner1.address, create.data, create.to);

    const launch = { name: "Nova Protocol", symbol: "NOVA", supply: 10n ** 27n, recipient: safe, salt: pad("0x77", { size: 32 }) };
    base = await predictLaunchedToken(client, factory, owner1.address, launch);
    const launchCall = buildLaunchTokenCall(chainId, factory, launch);
    await send(owner1.address, launchCall.data, launchCall.to);

    const usd = mockTokenDeployment("Demo Dollar", "dUSD", 6);
    quote = getAddress((await send(owner1.address, encodeDeployData({ abi: usd.abi, bytecode: usd.bytecode, args: usd.args }))).contractAddress!);
    for (const [to, amount] of [[safe, 1_000_000n], [TAKER, 10_000n]] as const) {
      const mint = buildMintCall(chainId, quote, to, amount * 10n ** 6n);
      await send(owner1.address, mint.data, mint.to);
    }

    await viaSafe(safe, buildEnableModuleCall(chainId, safe, fork.module));
    const anchorCall = buildLaunchAnchorCall(chainId, launcher, { base, quote, initialPriceX36: parsePriceX36("0.40", 18, 6) });
    await send(owner1.address, anchorCall.data, anchorCall.to);
    await advance(1900);
    const status = await readAnchorStatus(client, { chainId, launcher, base, quote });
    assert.ok(status.anchor && status.ready);
    anchor = status.anchor;

    // The platform's indexer and API, pointed at this fork's factory.
    config = testConfig({ API_AUTH_ORIGINS: TEST_WEB_ORIGIN, API_AUTH_PER_MINUTE: "100", INDEXER_TOKEN_FACTORY: factory });
    indexed = await indexDemoChain(config);
    cache = await Cache.connect(config.REDIS_URL);
    let n = 0;
    app = createApp({ db: indexed.db, cache, config, log: () => {}, chain: async () => indexed.ctx, clientIp: () => `lifecycle-${Date.now()}-${n++}` });
    await catchUp();
    const launched = (await call(null, "GET", `/v1/chains/${config.INDEXER_CHAIN_ID}/tokens/launched?recipient=${safe}`)).body.data as Json[];
    assert.deepEqual(launched.map((t) => [t.token, t.symbol]), [[base.toLowerCase(), "NOVA"]]);
  });

  test("2. the market maker lists itself; the owners propose; it signs the exact terms", async () => {
    for (const [name, account] of Object.entries({ owner1, mm })) cookies[name] = await signIn(app, account, config.INDEXER_CHAIN_ID);
    const profile = await call("mm", "PUT", "/v1/mms/me", { displayName: "Lifecycle Desk", coverage: ["Base launches"] });
    assert.equal(profile.status, 200);
    assert.ok(((await call(null, "GET", "/v1/mms")).body.data as Json[]).some((p) => p.address === mm.address.toLowerCase()));

    const now = (await client.getBlock()).timestamp;
    const terms: MandateTerms = {
      marketMaker: mm.address,
      base,
      quote,
      bounds: {
        allotment: 10n ** 24n, releaseStart: now - 10n * 86_400n, releaseDuration: 180n * 86_400n, epochLength: 86_400n,
        maxEpochCap: 5n * 10n ** 22n, maxShippedQuote: 10n ** 11n, floorPriceX36: parsePriceX36("0.30", 18, 6),
        maxAnchorDeviationBps: 300, twapWindow: 1800, spreadBpsMin: 10, spreadBpsMax: 200, mmFeeShareBps: 5000, anchor,
      },
      // 250,000 base against 100,000 quote: the 0.40 pool price.
      params: { spreadBps: 80, epochCap: 5n * 10n ** 22n, shippedBase: 25n * 10n ** 22n, shippedQuote: 10n ** 11n },
    };
    const sent = await call("owner1", "POST", "/v1/proposals", {
      chainId: config.INDEXER_CHAIN_ID, safe, terms: termsToJson(terms), expiresAt: Math.floor(Date.now() / 1000) + 7 * 86_400, note: "Launch week", send: true,
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));

    const inbox = (await call("mm", "GET", "/v1/proposals?as=mm")).body.data as Json[];
    const p = inbox[0]!;
    assert.equal(p.status, "sent");
    const typed = mandateTermsTypedData(fork, { proposalId: p.id, safe, terms: termsFromJson(p.terms), expiresAt: BigInt(p.expiresAt) });
    const accepted = await call("mm", "POST", `/v1/proposals/${p.id}/accept`, { signature: await mm.signTypedData(typed) });
    assert.equal(accepted.body.data.status, "accepted");
  });

  test("3. the owners execute the accepted terms and the proposal links to the mandate", async () => {
    const [p] = (await call("owner1", "GET", `/v1/proposals?safe=${safe}`)).body.data as Json[];
    await viaSafe(safe, buildCreateMandateCall(fork, termsFromJson(p!.terms)));
    const [id] = await client.readContract({ address: fork.module, abi: mandateModuleAbi, functionName: "mandatesOf", args: [safe] });
    const linked = await call("owner1", "POST", `/v1/proposals/${p!.id}/executed`, { mandateId: id });
    assert.equal(linked.body.data.status, "executed");
    assert.equal(linked.body.data.mandateId, id!.toLowerCase());
  });

  test("4. a taker trades; the issuer, the market maker and the marketplace see it", async () => {
    const [id] = await client.readContract({ address: fork.module, abi: mandateModuleAbi, functionName: "mandatesOf", args: [safe] });
    const buy = { taker: TAKER, tokenIn: quote, tokenOut: base, amount: 1_000n * 10n ** 18n, isExactIn: false };
    const quoted = await indexed.ctx.sdk.quote(id!, buy);
    assert.ok(quoted.ok, quoted.ok ? "" : quoted.error.message);
    const approve = buildApproveRouterCall(fork, quote, quoted.amountIn);
    await send(TAKER, approve.data, approve.to);
    const order = await client.readContract({ address: fork.module, abi: mandateModuleAbi, functionName: "activeOrder", args: [id!] });
    const swap = buildSwapCall(fork, { order, tokenIn: quote, tokenOut: base, amount: buy.amount, isExactIn: false,
      threshold: quoted.amountIn, deadline: (await client.getBlock()).timestamp + 600n });
    await send(TAKER, swap.data, swap.to);

    // Probe rounds over the following hour feed the availability component.
    const prober = new Prober(indexed.ctx, indexed.db, config, () => {});
    for (let round = 0; round < 6; round++) {
      await catchUp();
      await prober.probeOnce();
      await advance(600);
    }
    await catchUp();

    const chain = `/v1/chains/${config.INDEXER_CHAIN_ID}`;
    const [issuerRow] = (await call(null, "GET", `${chain}/safes/${safe}/summary`)).body.data as Json[];
    assert.equal(issuerRow!.fills, 1);
    assert.equal(issuerRow!.totalNetSold, buy.amount.toString());
    assert.equal(issuerRow!.tokens.base.symbol, "NOVA");
    assert.ok(BigInt(issuerRow!.mmEarnedQuote) > 0n, "the market maker earned its share of the spread");

    const [mmRow] = (await call(null, "GET", `${chain}/mms/${mm.address}/summary`)).body.data as Json[];
    assert.equal(mmRow!.mandateId, id!.toLowerCase());
    assert.equal(mmRow!.mmEarnedQuote, ((BigInt(mmRow!.feesQuote) * 5000n) / 10_000n).toString());

    const score = (await call(null, "GET", `${chain}/mms/${mm.address}/score`)).body.data as Json;
    assert.equal(score.status, "scored");
    assert.equal(score.components.availability.value, 1, "every probe round would fill");
    assert.ok(score.components.volume.value > 0);
    assert.ok(score.score > 0 && score.score <= 100);
  });
});

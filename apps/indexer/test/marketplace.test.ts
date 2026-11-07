import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { getLocalForkDeployment } from "@mandate/chains";
import { buildAddStrategyCall, buildMintCall, mandateModuleAbi, safeAbi, strategyTermsTypedData, termsFromJson, termsToJson, type StrategyTerms, type StrategyTermsJson } from "@mandate/sdk";
import postgres from "postgres";
import { concat, createPublicClient, createWalletClient, encodeFunctionData, http, pad, toHex, zeroAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import { createChainContext } from "../src/chain.ts";
import { createDb } from "../src/db/client.ts";
import { resetDatabase, rpc, signIn, skip, TEST_WEB_ORIGIN, testConfig } from "./helpers.ts";

/**
 * Market-maker profiles and proposals against the local fork's demo Safe (owners: Anvil #0 and #1, module enabled,
 * a live policy for the demo pair). The Safe gets extra demo inventory so a second strategy is backed, and the last
 * test executes addStrategy through the Safe, so the fork is snapshotted and restored. Anvil public development keys
 * only; the test database is wiped.
 */
const fork = getLocalForkDeployment();
const owner1 = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const owner2 = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const mm = privateKeyToAccount("0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a");
const outsider = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const SAFE = fork.safe1;

type Json = Record<string, any>;

describe("marketplace: profiles and proposals", { skip }, () => {
  const config = testConfig({ API_AUTH_ORIGINS: TEST_WEB_ORIGIN, API_AUTH_PER_MINUTE: "100" });
  const publicClient = createPublicClient({ transport: http(config.INDEXER_RPC_URL), cacheTime: 0 });
  let cache: Cache;
  let handle: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  const cookies: Record<string, string> = {};
  let snapshot: string;

  before(async () => {
    await resetDatabase(config.DATABASE_URL);
    handle = createDb(config.DATABASE_URL);
    cache = await Cache.connect(config.REDIS_URL);
    const chain = createChainContext(config);
    // A fresh client id per request keeps rate-limit windows from leaking between runs.
    let n = 0;
    app = createApp({ db: handle.db, cache, config, log: () => {}, chain: () => chain, clientIp: () => `marketplace-${Date.now()}-${n++}` });
    for (const [name, account] of Object.entries({ owner1, owner2, mm, outsider })) cookies[name] = await signIn(app, account, config.INDEXER_CHAIN_ID);
    snapshot = await rpc<string>(config.INDEXER_RPC_URL, "evm_snapshot");
    // The demo Safe's live strategy already uses all its tokens; owner 1 (the demo tokens' owner) mints more.
    const wallet = createWalletClient({ transport: http(config.INDEXER_RPC_URL) });
    for (const [token, amount] of [[fork.base, 10n ** 24n], [fork.quote, 4n * 10n ** 11n]] as const) {
      const mint = buildMintCall(config.INDEXER_CHAIN_ID, token, SAFE, amount);
      await publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: owner1.address, to: mint.to, data: mint.data, chain: null }) });
    }
  });
  after(async () => {
    await rpc(config.INDEXER_RPC_URL, "evm_revert", [snapshot]);
    await cache.close();
    await handle.close();
  });

  const call = async (who: string | null, method: string, path: string, body?: unknown) => {
    const headers: Record<string, string> = { origin: TEST_WEB_ORIGIN };
    if (who) headers.cookie = cookies[who]!;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await app.request(path, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: (await response.json().catch(() => ({}))) as Json };
  };

  /** Valid strategy terms for the demo pair: ratio at the anchor's ~0.40. */
  async function demoTerms(overrides: Partial<StrategyTerms["bounds"]> = {}): Promise<StrategyTermsJson> {
    const terms: StrategyTerms = {
      marketMaker: mm.address,
      base: fork.base,
      quote: fork.quote,
      kind: 0,
      bounds: { spreadBpsMin: 10, spreadBpsMax: 200, maxShippedBase: 10n ** 23n, maxShippedQuote: 4n * 10n ** 10n,
        mmFeeShareBps: 5000, maxBuyPriceX36: 0n, ...overrides },
      params: { spreadBps: 80, shippedBase: 10n ** 23n, shippedQuote: 4n * 10n ** 10n },
    };
    return termsToJson(terms);
  }
  const expiry = () => Math.floor(Date.now() / 1000) + 7 * 86_400;

  describe("profiles", () => {
    test("only the signed-in wallet writes its own profile, from an allowed origin", async () => {
      const profile = { displayName: "Demo MM", bio: "Market making for Base launches.\nTwo lines.", website: "https://mm.example", contact: "@demo_mm", coverage: ["Base launches", "USDC pairs", "Base launches"], minDealUsd: 50_000 };
      assert.equal((await call(null, "PUT", "/v1/mms/me", profile)).status, 401);
      const wrongOrigin = await app.request("/v1/mms/me", { method: "PUT", headers: { cookie: cookies.mm!, origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify(profile) });
      assert.equal(wrongOrigin.status, 403);
      assert.equal((await call("mm", "PUT", "/v1/mms/me", { ...profile, website: "http://mm.example" })).status, 400);

      const saved = await call("mm", "PUT", "/v1/mms/me", { ...profile, displayName: "  Demo\u0007 MM‮ " });
      assert.equal(saved.status, 200);
      assert.equal(saved.body.data.address, mm.address.toLowerCase());
      assert.equal(saved.body.data.displayName, "Demo MM", "control and bidi characters stripped");
      assert.deepEqual(saved.body.data.coverage, ["Base launches", "USDC pairs"]);
      assert.equal(saved.body.data.bio, profile.bio, "newlines kept in the bio");
    });

    test("the public list shows listed profiles and reflects edits at once", async () => {
      assert.equal((await call(null, "GET", "/v1/mms")).body.data.length, 1);
      await call("outsider", "PUT", "/v1/mms/me", { displayName: "Quiet MM", listed: false });
      const list = (await call(null, "GET", "/v1/mms")).body.data as Json[];
      assert.deepEqual(list.map((p) => p.displayName), ["Demo MM"]);
      assert.equal((await call(null, "GET", `/v1/mms/${outsider.address}`)).body.data.listed, false, "unlisted still reachable");
      await call("mm", "PUT", "/v1/mms/me", { displayName: "Demo MM v2" });
      assert.equal(((await call(null, "GET", "/v1/mms")).body.data as Json[])[0]!.displayName, "Demo MM v2");
      assert.equal((await call(null, "GET", "/v1/mms/0xnot")).status, 400);
    });
  });

  describe("proposals", () => {
    let proposal: Json;

    test("only a Safe owner can propose; drafts stay hidden from the market maker", async () => {
      const body = { chainId: config.INDEXER_CHAIN_ID, safe: SAFE, terms: await demoTerms(), expiresAt: expiry(), note: "Launch on Monday" };
      assert.equal((await call("outsider", "POST", "/v1/proposals", body)).status, 403);
      assert.equal((await call("owner1", "POST", "/v1/proposals", { ...body, expiresAt: Math.floor(Date.now() / 1000) + 60 })).status, 400);
      const created = await call("owner1", "POST", "/v1/proposals", body);
      assert.equal(created.status, 201);
      proposal = created.body.data;
      assert.equal(proposal.status, "draft");
      assert.match(proposal.termsHash, /^0x[0-9a-f]{64}$/);

      assert.equal((await call("mm", "GET", `/v1/proposals/${proposal.id}`)).status, 404);
      assert.equal(((await call("mm", "GET", "/v1/proposals?as=mm")).body.data as Json[]).length, 0);
      // The co-owner sees it through the Safe; an outsider learns nothing.
      assert.equal(((await call("owner2", "GET", `/v1/proposals?safe=${SAFE}`)).body.data as Json[])[0]!.id, proposal.id);
      assert.equal((await call("outsider", "GET", `/v1/proposals?safe=${SAFE}`)).status, 403);
      assert.equal((await call("outsider", "GET", `/v1/proposals/${proposal.id}`)).status, 404);
    });

    test("terms the module would refuse cannot be sent", async () => {
      // A buyback price on a market-making strategy is InvalidStrategy onchain.
      const bad = await call("owner1", "POST", "/v1/proposals", {
        chainId: config.INDEXER_CHAIN_ID, safe: SAFE, terms: await demoTerms({ maxBuyPriceX36: 1n }), expiresAt: expiry(), send: true,
      });
      assert.equal(bad.status, 422);
      assert.match(bad.body.reason, /maximum buyback price/);
      // A Safe without a live policy for the pair is told to create one first.
      const noPolicy = await call("owner1", "POST", "/v1/proposals", {
        chainId: config.INDEXER_CHAIN_ID, safe: fork.safe3, terms: await demoTerms(), expiresAt: expiry(), send: true,
      });
      assert.equal(noPolicy.status, 422);
      assert.match(noPolicy.body.reason, /no live treasury policy/);
    });

    test("sending, then only the named market maker can accept, with a signature over the exact terms", async () => {
      const sent = await call("owner2", "POST", `/v1/proposals/${proposal.id}/send`);
      assert.equal(sent.status, 200);
      assert.equal(sent.body.data.status, "sent");
      assert.equal(((await call("mm", "GET", "/v1/proposals?as=mm")).body.data as Json[])[0]!.id, proposal.id);

      const typed = strategyTermsTypedData(fork, {
        proposalId: proposal.id, safe: SAFE, terms: termsFromJson(proposal.terms), expiresAt: BigInt(proposal.expiresAt),
      });
      // The outsider is not the proposal's market maker, so it cannot even address it.
      assert.equal((await call("outsider", "POST", `/v1/proposals/${proposal.id}/accept`, { signature: await outsider.signTypedData(typed) })).status, 404);
      // The market maker signing different terms (another expiry) is refused.
      const other = strategyTermsTypedData(fork, { proposalId: proposal.id, safe: SAFE, terms: termsFromJson(proposal.terms), expiresAt: BigInt(proposal.expiresAt) + 1n });
      assert.equal((await call("mm", "POST", `/v1/proposals/${proposal.id}/accept`, { signature: await mm.signTypedData(other) })).status, 401);

      const accepted = await call("mm", "POST", `/v1/proposals/${proposal.id}/accept`, { signature: await mm.signTypedData(typed) });
      assert.equal(accepted.status, 200);
      assert.equal(accepted.body.data.status, "accepted");
      assert.equal((await call("mm", "POST", `/v1/proposals/${proposal.id}/decline`)).status, 409);
    });

    test("executed is recorded only for the Safe's matching strategy", async () => {
      // Another existing strategy (different terms) is refused.
      const wrong = await call("owner1", "POST", `/v1/proposals/${proposal.id}/executed`, { strategyId: fork.strategies.act1 });
      assert.equal(wrong.status, 422);

      // Owners add the strategy from the accepted terms under their policy: owner 1 approves, owner 2 executes.
      const terms = termsFromJson(proposal.terms);
      const policyId = fork.policies.act1;
      const create = buildAddStrategyCall(fork, { policyId, marketMaker: terms.marketMaker, kind: terms.kind, bounds: terms.bounds, params: terms.params });
      const nonce = await publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "nonce" });
      const txArgs = [create.to, 0n, create.data, 0, 0n, 0n, 0n, zeroAddress, zeroAddress] as const;
      const hash = await publicClient.readContract({ address: SAFE, abi: safeAbi, functionName: "getTransactionHash", args: [...txArgs, nonce] });
      const wallet = createWalletClient({ transport: http(config.INDEXER_RPC_URL) });
      const send = async (from: Address, data: Hex) =>
        publicClient.waitForTransactionReceipt({ hash: await wallet.sendTransaction({ account: from, to: SAFE, data, chain: null }) });
      await send(owner1.address, encodeFunctionData({ abi: safeAbi, functionName: "approveHash", args: [hash] }));
      const signatures = concat(
        [owner1.address, owner2.address]
          .sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1))
          .map((o) => concat([pad(o, { size: 32 }), pad("0x0", { size: 32 }), toHex(1, { size: 1 })])),
      );
      assert.equal((await send(owner2.address, encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [...txArgs, signatures] }))).status, "success");
      const ids = await publicClient.readContract({ address: fork.module, abi: mandateModuleAbi, functionName: "strategiesOf", args: [policyId] });

      const done = await call("owner2", "POST", `/v1/proposals/${proposal.id}/executed`, { strategyId: ids.at(-1) });
      assert.equal(done.status, 200);
      assert.equal(done.body.data.status, "executed");
      assert.equal(done.body.data.strategyId, ids.at(-1)!.toLowerCase());
      assert.equal((await call("owner1", "POST", `/v1/proposals/${proposal.id}/withdraw`)).status, 409);
    });

    test("expired proposals can no longer move; withdrawal is for owners", async () => {
      const created = await call("owner1", "POST", "/v1/proposals", {
        chainId: config.INDEXER_CHAIN_ID, safe: SAFE, terms: await demoTerms(), expiresAt: expiry(), send: true,
      });
      const id = created.body.data.id as string;
      assert.equal((await call("mm", "POST", `/v1/proposals/${id}/withdraw`)).status, 404);
      assert.equal((await call("owner2", "POST", `/v1/proposals/${id}/withdraw`)).body.data.status, "withdrawn");

      const second = await call("owner1", "POST", "/v1/proposals", {
        chainId: config.INDEXER_CHAIN_ID, safe: SAFE, terms: await demoTerms(), expiresAt: expiry(), send: true,
      });
      const sql = postgres(config.DATABASE_URL, { max: 1 });
      await sql`UPDATE proposals SET expires_at = now() - interval '1 minute' WHERE id = ${second.body.data.id}`;
      await sql.end();
      assert.equal((await call("mm", "GET", `/v1/proposals/${second.body.data.id}`)).body.data.status, "expired");
      assert.equal((await call("mm", "POST", `/v1/proposals/${second.body.data.id}/decline`)).status, 409);
    });
  });
});

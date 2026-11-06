import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import type { ChainContext } from "../src/chain.ts";
import { indexDemoChain, loadReplay, skip, testConfig } from "./helpers.ts";
import { getLocalForkDeployment } from "@mandate/chains";

/** These suites run against the local demo fork; its manifest supplies the fork-only addresses. */
const fork = getLocalForkDeployment();

// Response bodies are asserted field by field, so tests read them untyped.
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

const NON_STRATEGY_KINDS = new Set(["approval", "traditional-sell", "market-move"]);
const TRADE_KINDS = new Set(["treasury-sell", "treasury-buyback"]);

describe("read API over the indexed demo chain", { skip }, () => {
  const config = testConfig();
  let app: ReturnType<typeof createApp>;
  let cache: Cache;
  let ctx: ChainContext;
  let close: () => Promise<void>;
  let db: Parameters<typeof createApp>[0]["db"];

  before(async () => {
    const indexed = await indexDemoChain(config);
    ({ ctx, db } = indexed);
    close = indexed.close;
    cache = await Cache.connect(config.REDIS_URL);
    app = createApp({
      db,
      cache,
      config,
      log: () => {},
    });
  });

  after(async () => {
    await cache.close();
    await close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(path, { headers }) as Promise<JsonResponse>;
  const base = "/v1/chains/31337";

  test("health reports db, redis and head", async () => {
    const res = await get("/health");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.redis, true);
    assert.equal(body.head.number, (await ctx.client.getBlockNumber()).toString());
  });

  test("lists policies and strategies, filtered by safe, market maker and policy", async () => {
    const policies = await (await get(`${base}/policies`)).json();
    assert.equal(policies.data.length, 3);
    const mine = await (await get(`${base}/policies?safe=${fork.safe1}`)).json();
    assert.equal(mine.data.length, 1);
    assert.equal(mine.data[0].policyId, fork.policies.act1.toLowerCase());
    const strategies = await (await get(`${base}/strategies`)).json();
    assert.equal(strategies.data.length, 3);
    const byPolicy = await (await get(`${base}/strategies?policy=${fork.policies.act2}`)).json();
    assert.deepEqual(byPolicy.data.map((s: any) => s.strategyId), [fork.strategies.act2.toLowerCase()]);
    const byMm = await (await get(`${base}/strategies?mm=${fork.mm}`)).json();
    assert.equal(byMm.data.length, 3);
  });

  test("strategy detail carries its policy, both latest readings and provenance, then hits the cache", async () => {
    const path = `${base}/strategies/${fork.strategies.act1}`;
    const first = await get(path);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.data.strategy.strategyId, fork.strategies.act1.toLowerCase());
    assert.equal(body.data.policy.policyId, fork.policies.act1.toLowerCase());
    assert.equal(body.data.chain.environment, "local-mainnet-fork");
    assert.equal(body.data.snapshot.blockNumber, body.head.number);
    assert.equal(body.data.policySnapshot.blockNumber, body.head.number);
    assert.match(body.data.policySnapshot.netSold, /^\d+$/, "uint256 as decimal string");
    const second = await get(path);
    assert.equal(second.headers.get("x-cache"), "hit");
    assert.deepEqual(await second.json(), body);
  });

  test("policy detail lists its strategies and its risk reading", async () => {
    const body = await (await get(`${base}/policies/${fork.policies.act2}`)).json();
    assert.equal(body.data.policy.safe, fork.safe2.toLowerCase());
    assert.equal(body.data.strategies.length, 1);
    assert.equal(body.data.snapshot.riskMode, 0);
    assert.equal(body.data.snapshot.priced, true);
  });

  test("rejects malformed input and unknown resources", async () => {
    assert.equal((await get(`${base}/strategies/0x1234`)).status, 400);
    assert.equal((await get(`${base}/strategies/${"0x" + "ab".repeat(32)}`)).status, 404);
    assert.equal((await get(`${base}/policies/${"0x" + "ab".repeat(32)}`)).status, 404);
    assert.equal((await get(`/v1/chains/999/strategies`)).status, 404);
    assert.equal((await get(`${base}/strategies/${fork.strategies.act1}/activity?before=%%%`)).status, 400);
    assert.equal((await get(`${base}/strategies/${fork.strategies.act1}/activity?limit=100000`)).status, 400);
  });

  test("activity paginates through every fill and blocked attempt exactly once, newest first", async () => {
    const replay = await loadReplay();
    for (const act of replay.acts) {
      const expected =
        act.steps.filter((s) => TRADE_KINDS.has(s.kind) && s.outcome === "executed").length +
        act.steps.filter((s) => !NON_STRATEGY_KINDS.has(s.kind) && s.outcome === "blocked").length;
      const keys = new Set<string>();
      let previous: [number, number] | undefined;
      let cursor: string | null = null;
      do {
        const query: string = `limit=17${cursor ? `&before=${cursor}` : ""}`;
        const page = await (await get(`${base}/strategies/${act.strategyId}/activity?${query}`)).json();
        for (const item of page.data.items) {
          assert.ok(!keys.has(item.key), `duplicate ${item.key}`);
          keys.add(item.key);
          const position: [number, number] = [Number(item.block_number), Number(item.ord)];
          if (previous) {
            assert.ok(position[0] < previous[0] || (position[0] === previous[0] && position[1] <= previous[1]), "desc order");
          }
          previous = position;
          if (item.kind === "attempt") assert.ok(item.explanation, "blocked rows explain themselves");
        }
        cursor = page.data.next;
      } while (cursor);
      assert.equal(keys.size, expected, `act ${act.act} activity`);
      // One strategy per policy here, so the policy's feed is the same set.
      const policyFeed = await (await get(`${base}/policies/${act.policyId}/activity?limit=200`)).json();
      assert.deepEqual(new Set(policyFeed.data.items.map((i: any) => i.key)), keys);
    }
  });

  test("strategies carry token display metadata", async () => {
    const body = await (await get(`${base}/strategies/${fork.strategies.act1}`)).json();
    assert.deepEqual(body.data.tokens, { base: { symbol: "LAUNCH", decimals: 18 }, quote: { symbol: "sUSDC", decimals: 6 } });
  });

  test("Safe and market-maker summaries match fills, refusals and the latest readings", async () => {
    const all = (await (await get(`${base}/strategies`)).json()).data as { strategyId: string; policyId: string; safe: string; mm: string }[];
    for (const s of all) {
      const summary = (await (await get(`${base}/safes/${s.safe}/summary`)).json()).data as any[];
      const policy = summary.find((p) => p.policyId === s.policyId);
      assert.ok(policy, "the Safe's policy is in its summary");
      const row = policy.strategies.find((r: any) => r.strategyId === s.strategyId);
      assert.ok(row, "with its strategy");
      let fills = 0;
      let refused = 0;
      let cursor: string | null = null;
      do {
        const page: any = await (await get(`${base}/strategies/${s.strategyId}/activity?limit=100${cursor ? `&before=${cursor}` : ""}`)).json();
        for (const item of page.data.items) {
          if (item.kind === "fill") fills++;
          else if (item.outcome === "blocked") refused++;
        }
        cursor = page.data.next;
      } while (cursor);
      assert.equal(row.fills, fills);
      assert.equal(row.refused, refused);
      const detail = (await (await get(`${base}/policies/${s.policyId}`)).json()).data;
      assert.equal(policy.totalNetSold, detail.snapshot.totalNetSold);
      assert.equal(policy.riskMode, detail.snapshot.riskMode);
      assert.equal(policy.tokens.base.symbol, "LAUNCH");
      if (fills > 0) assert.equal(typeof row.avgQualityBps, "number", "execution quality averaged over fills");
      // The market maker's share of the spread fees, as MandateModule._claimable computes it.
      const share = BigInt(row.mmFeeShareBps);
      assert.equal(row.mmEarnedQuote, ((BigInt(row.feesQuote) * share) / 10_000n).toString());
      assert.ok(BigInt(row.claimedQuote) <= BigInt(row.mmEarnedQuote));
    }
    assert.deepEqual((await (await get(`${base}/safes/0x000000000000000000000000000000000000beef/summary`)).json()).data, []);
    // The market maker's view lists the same strategies, each with its treasury's risk mode.
    const byMm = (await (await get(`${base}/mms/${all[0]!.mm}/summary`)).json()).data as any[];
    assert.deepEqual(byMm.map((r) => r.strategyId).sort(), all.filter((s) => s.mm === all[0]!.mm).map((s) => s.strategyId).sort());
    assert.ok(byMm.every((r) => r.riskMode !== null && r.tokens.quote.symbol === "sUSDC"));
  });

  test("series return readings in block order", async () => {
    for (const path of [`policies/${fork.policies.act2}`, `strategies/${fork.strategies.act2}`]) {
      const body = await (await get(`${base}/${path}/series?limit=2000`)).json();
      assert.ok(body.data.length > 1);
      for (let i = 1; i < body.data.length; i++) {
        assert.ok(BigInt(body.data[i].blockNumber) > BigInt(body.data[i - 1].blockNumber));
      }
    }
  });

  test("CORS allows only configured origins; security headers are set", async () => {
    const allowed = await get("/health", { origin: "http://localhost:5173" });
    assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
    const denied = await get("/health", { origin: "https://evil.example" });
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
    assert.equal(allowed.headers.get("x-content-type-options"), "nosniff");
  });

  test("serves from Postgres when Redis is down", async () => {
    const deadCache = await Cache.connect("redis://127.0.0.1:1");
    const degraded = createApp({ db, cache: deadCache, config, log: () => {} });
    const res = (await degraded.request(`${base}/strategies/${fork.strategies.act3}`)) as JsonResponse;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cache"), "miss");
    assert.equal((await res.json()).data.strategy.status, 3);
    await deadCache.close();
  });
});

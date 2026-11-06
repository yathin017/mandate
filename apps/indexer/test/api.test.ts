import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import type { ChainContext } from "../src/chain.ts";
import { indexDemoChain, loadReplay, skip, testConfig } from "./helpers.ts";

// Response bodies are asserted field by field, so tests read them untyped.
type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

const NON_MANDATE_KINDS = new Set(["approval", "traditional-sell", "market-move"]);
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
    app = createApp({ db, cache, config, log: () => {} });
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

  test("lists all mandates and filters by safe", async () => {
    const all = await (await get(`${base}/mandates`)).json();
    assert.equal(all.data.length, 3);
    const one = await (await get(`${base}/mandates?safe=${ctx.deployment.safe1}`)).json();
    assert.equal(one.data.length, 1);
    assert.equal(one.data[0].safe, ctx.deployment.safe1.toLowerCase());
  });

  test("mandate detail carries snapshot and provenance, then hits the cache", async () => {
    const path = `${base}/mandates/${ctx.deployment.mandates.act1}`;
    const first = await get(path);
    assert.equal(first.status, 200);
    const body = await first.json();
    assert.equal(body.data.mandate.mandateId, ctx.deployment.mandates.act1.toLowerCase());
    assert.equal(body.data.chain.environment, "local-mainnet-fork");
    assert.equal(body.data.snapshot.blockNumber, body.head.number);
    assert.match(body.data.snapshot.totalNetSold, /^\d+$/, "uint256 as decimal string");
    const second = await get(path);
    assert.equal(second.headers.get("x-cache"), "hit");
    assert.deepEqual(await second.json(), body);
  });

  test("rejects malformed input and unknown resources", async () => {
    assert.equal((await get(`${base}/mandates/0x1234`)).status, 400);
    assert.equal((await get(`${base}/mandates/${"0x" + "ab".repeat(32)}`)).status, 404);
    assert.equal((await get(`/v1/chains/999/mandates`)).status, 404);
    assert.equal((await get(`${base}/mandates/${ctx.deployment.mandates.act1}/activity?before=%%%`)).status, 400);
    assert.equal((await get(`${base}/mandates/${ctx.deployment.mandates.act1}/activity?limit=100000`)).status, 400);
  });

  test("activity paginates through every fill and blocked attempt exactly once, newest first", async () => {
    const replay = await loadReplay();
    for (const act of replay.acts) {
      const expected =
        act.steps.filter((s) => TRADE_KINDS.has(s.kind) && s.outcome === "executed").length +
        act.steps.filter((s) => !NON_MANDATE_KINDS.has(s.kind) && s.outcome === "blocked").length;
      const keys = new Set<string>();
      let previous: [number, number] | undefined;
      let cursor: string | null = null;
      do {
        const query: string = `limit=17${cursor ? `&before=${cursor}` : ""}`;
        const page = await (await get(`${base}/mandates/${act.mandateId}/activity?${query}`)).json();
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
    }
  });

  test("series returns snapshots in block order", async () => {
    const body = await (await get(`${base}/mandates/${ctx.deployment.mandates.act2}/series?limit=2000`)).json();
    assert.ok(body.data.length > 1);
    for (let i = 1; i < body.data.length; i++) {
      assert.ok(BigInt(body.data[i].blockNumber) > BigInt(body.data[i - 1].blockNumber));
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
    const res = (await degraded.request(`${base}/mandates/${ctx.deployment.mandates.act3}`)) as JsonResponse;
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-cache"), "miss");
    assert.equal((await res.json()).data.mandate.status, 3);
    await deadCache.close();
  });
});

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { and, count, eq } from "drizzle-orm";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import type { ChainContext } from "../src/chain.ts";
import { attempts } from "../src/db/schema.ts";
import { indexDemoChain, skip, testConfig } from "./helpers.ts";

type JsonResponse = Omit<Response, "json"> & { json(): Promise<any> };

describe("simulated attempts", { skip }, () => {
  const config = testConfig({ API_ATTEMPTS_PER_MINUTE: "1000" });
  let ctx: ChainContext;
  let db: Parameters<typeof createApp>[0]["db"];
  let close: () => Promise<void>;
  let cache: Cache;
  let app: ReturnType<typeof createApp>;
  const run = `run-${Date.now()}`;

  before(async () => {
    const indexed = await indexDemoChain(config);
    ({ ctx, db } = indexed);
    close = indexed.close;
    cache = await Cache.connect(config.REDIS_URL);
    app = createApp({ db, cache, config, chain: async () => ctx, clientIp: () => `${run}-main`, log: () => {} });
  });

  after(async () => {
    await cache.close();
    await close();
  });

  const post = (target: ReturnType<typeof createApp>, mandateId: string, body: unknown) =>
    target.request(`/v1/chains/31337/mandates/${mandateId}/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }) as Promise<JsonResponse>;

  const sell = () => ({
    taker: ctx.deployment.deployer,
    tokenIn: ctx.deployment.quote,
    tokenOut: ctx.deployment.base,
    amount: "100000000", // 100 sUSDC
    isExactIn: true,
  });

  test("a sell past Act 1's epoch cap is blocked with the real reason", async () => {
    const res = await post(app, ctx.deployment.mandates.act1, sell());
    assert.equal(res.status, 201);
    const { data } = await res.json();
    assert.equal(data.simulated, true);
    assert.equal(data.outcome, "blocked");
    assert.equal(data.errorName, "EpochCapReached");
    assert.match(data.explanation, /Blocked by Mandate/);
  });

  test("the revoked Act 3 mandate refuses every fill", async () => {
    const { data } = await (await post(app, ctx.deployment.mandates.act3, sell())).json();
    assert.equal(data.outcome, "blocked");
    assert.ok(data.errorName);
  });

  test("simulated rows appear in the feed immediately and repeats are deduped", async () => {
    const id = ctx.deployment.mandates.act1;
    const feedPath = `/v1/chains/31337/mandates/${id}/activity?limit=5`;
    await app.request(feedPath); // warm the cache
    const first = await (await post(app, id, { ...sell(), amount: "123000000" })).json();
    const again = await (await post(app, id, { ...sell(), amount: "123000000" })).json();
    assert.equal(again.data.requestHash, first.data.requestHash);

    const rows = await db
      .select({ n: count() })
      .from(attempts)
      .where(and(eq(attempts.source, "simulated"), eq(attempts.requestHash, first.data.requestHash)));
    assert.equal(rows[0]!.n, 1, "one row per request per block");

    const feed = await ((await app.request(feedPath)) as JsonResponse).json();
    assert.equal(feed.data.items[0].source, "simulated", "newest item is the simulation");
    assert.equal(feed.data.items[0].request.amount, "123000000");
  });

  test("clients cannot supply outcomes or malformed amounts", async () => {
    const id = ctx.deployment.mandates.act1;
    assert.equal((await post(app, id, { ...sell(), outcome: "allowed" })).status, 400);
    assert.equal((await post(app, id, { ...sell(), amount: "-1" })).status, 400);
    assert.equal((await post(app, id, { ...sell(), amount: "1".repeat(80) })).status, 400);
    assert.equal((await post(app, id, { ...sell(), taker: "0x123" })).status, 400);
    assert.equal((await post(app, "0x" + "cd".repeat(32), sell())).status, 404);
  });

  test("rate limit returns 429 after the configured budget", async () => {
    const limited = createApp({
      db,
      cache,
      config: testConfig({ API_ATTEMPTS_PER_MINUTE: "3" }),
      chain: async () => ctx,
      clientIp: () => `${run}-limited`,
      log: () => {},
    });
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await post(limited, ctx.deployment.mandates.act1, sell())).status);
    assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
  });

  test("fails closed when the rate limiter is unavailable", async () => {
    const dead = await Cache.connect("redis://127.0.0.1:1");
    const degraded = createApp({ db, cache: dead, config, chain: async () => ctx, log: () => {} });
    assert.equal((await post(degraded, ctx.deployment.mandates.act1, sell())).status, 503);
    await dead.close();
  });
});

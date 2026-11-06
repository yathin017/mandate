import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { Cache, type MandateChange } from "../src/cache/cache.ts";
import { keys } from "../src/cache/keys.ts";

const redisUrl = process.env.INDEXER_TEST_REDIS_URL;

describe("cache degrades instead of failing", () => {
  test("an unreachable Redis returns undefined quickly and never throws", async () => {
    const cache = await Cache.connect("redis://127.0.0.1:1");
    const started = Date.now();
    assert.equal(await cache.getJson("anything"), undefined);
    await cache.setJson("anything", { a: 1 });
    assert.equal(await cache.hit("rl", 60), undefined);
    assert.equal(await cache.healthy(), false);
    assert.ok(Date.now() - started < 3000, "fails fast");
    assert.ok(cache.failureCount > 0);
    await cache.close();
  });
});

describe("cache against Redis", { skip: redisUrl ? false : "set INDEXER_TEST_REDIS_URL" }, () => {
  test("json round trip, head and rate counter", async () => {
    const cache = await Cache.connect(redisUrl!);
    await cache.setHead(1, { number: "10", hash: "0xabc" });
    assert.deepEqual(await cache.getHead(1), { number: "10", hash: "0xabc" });
    const key = keys.rateLimit("test", `client-${Date.now()}`, 1);
    assert.equal(await cache.hit(key, 60), 1);
    assert.equal(await cache.hit(key, 60), 2);
    await cache.close();
  });

  test("published changes reach subscribers of that mandate only", async () => {
    const cache = await Cache.connect(redisUrl!);
    const received: MandateChange[] = [];
    const unsubscribe = await cache.subscribe(7, "0xmine", (change) => received.push(change));
    const change = { chainId: 7, mandateId: "0xmine", blockNumber: "5", blockHash: "0xh", reorg: false };
    await cache.publish({ ...change, mandateId: "0xother" });
    await cache.publish(change);
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(received, [change]);
    unsubscribe();
    await cache.close();
  });
});

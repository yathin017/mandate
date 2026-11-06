import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import type { ChainContext } from "../src/chain.ts";
import { indexDemoChain, skip, testConfig } from "./helpers.ts";

/** Reads SSE text until `predicate` matches the accumulated buffer or the timeout passes. */
async function readUntil(body: ReadableStream<Uint8Array>, predicate: (text: string) => boolean, ms = 3000) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + ms;
  try {
    while (Date.now() < deadline && !predicate(text)) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value: undefined }>((resolve) =>
          setTimeout(() => resolve({ done: true, value: undefined }), deadline - Date.now()),
        ),
      ]);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  return text;
}

describe("live mandate stream", { skip }, () => {
  const config = testConfig();
  let ctx: ChainContext;
  let db: Parameters<typeof createApp>[0]["db"];
  let close: () => Promise<void>;
  let cache: Cache;

  before(async () => {
    const indexed = await indexDemoChain(config);
    ({ ctx, db } = indexed);
    close = indexed.close;
    cache = await Cache.connect(config.REDIS_URL);
  });

  after(async () => {
    await cache.close();
    await close();
  });

  const path = () => `/v1/chains/31337/mandates/${ctx.deployment.mandates.act2}/stream`;

  test("sends ready, then a change when the worker publishes", async () => {
    const app = createApp({ db, cache, config, log: () => {} });
    const controller = new AbortController();
    const res = await app.request(path(), { signal: controller.signal });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const body = res.body!;
    assert.match(await readUntil(body, (t) => t.includes("event: ready")), /event: ready/);
    await cache.publish({
      chainId: 31337,
      mandateId: ctx.deployment.mandates.act2.toLowerCase(),
      blockNumber: "1",
      blockHash: "0xfeed",
      reorg: false,
    });
    const text = await readUntil(body, (t) => t.includes("event: change"));
    assert.match(text, /event: change/);
    assert.match(text, /0xfeed/);
    controller.abort();
  });

  test("caps concurrent streams and releases the slot on disconnect", async () => {
    const app = createApp({ db, cache, config, maxStreams: 1, log: () => {} });
    const first = new AbortController();
    const open = await app.request(path(), { signal: first.signal });
    await readUntil(open.body!, (t) => t.includes("event: ready"));
    assert.equal((await app.request(path())).status, 503);

    first.abort();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = new AbortController();
    const reopened = await app.request(path(), { signal: second.signal });
    assert.equal(reopened.status, 200);
    second.abort();
  });

  test("unknown mandates and a dead Redis are refused", async () => {
    const app = createApp({ db, cache, config, log: () => {} });
    assert.equal((await app.request(`/v1/chains/31337/mandates/0x${"ef".repeat(32)}/stream`)).status, 404);
    const dead = await Cache.connect("redis://127.0.0.1:1");
    const degraded = createApp({ db, cache: dead, config, log: () => {} });
    assert.equal((await degraded.request(path())).status, 503);
    await dead.close();
  });
});

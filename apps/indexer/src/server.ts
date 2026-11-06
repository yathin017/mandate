import { fileURLToPath } from "node:url";

import { serve } from "@hono/node-server";

import { createApp } from "./api/app.ts";
import { Cache } from "./cache/cache.ts";
import { createChainContext, type ChainContext } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { checkPostgres, checkRedis, checkSchema, runWithPreflight } from "./preflight.ts";

/** API process. Read-only against Postgres except simulated attempts; listens on loopback by default. */
const config = loadConfig();
// The API needs Postgres (and the worker's migrations); the RPC is only needed lazily for simulations.
await runWithPreflight("api", async () => {
  await checkPostgres(config.DATABASE_URL);
  await checkSchema(config.DATABASE_URL);
  await checkRedis(config.REDIS_URL, (message) => console.warn(`[api] ${message}`));
});
const { db, close } = createDb(config.DATABASE_URL);
const cache = await Cache.connect(config.REDIS_URL);
// Connected on first simulated attempt; a failed connection is retried on the next request.
let chain: Promise<ChainContext> | undefined;
const lazyChain = () => {
  chain ??= createChainContext(config).catch((error: unknown) => {
    chain = undefined;
    throw error;
  });
  return chain;
};
const replayPath = process.env.REPLAY_PATH ?? fileURLToPath(new URL("../../../replay/data/acts.json", import.meta.url));
const app = createApp({ db, cache, config, chain: lazyChain, replayPath });

const server = serve({ fetch: app.fetch, port: config.API_PORT, hostname: process.env.API_HOST ?? "127.0.0.1" }, (info) =>
  console.log(`[api] listening on http://${info.address}:${info.port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void cache.close().then(close);
  });
}

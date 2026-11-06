import { serve } from "@hono/node-server";

import { createApp } from "./api/app.ts";
import { Cache } from "./cache/cache.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";

/** API process. Read-only against Postgres except simulated attempts; listens on loopback by default. */
const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);
const cache = await Cache.connect(config.REDIS_URL);
const app = createApp({ db, cache, config });

const server = serve({ fetch: app.fetch, port: config.API_PORT, hostname: process.env.API_HOST ?? "127.0.0.1" }, (info) =>
  console.log(`[api] listening on http://${info.address}:${info.port}`),
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close();
    void cache.close().then(close);
  });
}

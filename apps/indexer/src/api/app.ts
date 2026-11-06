import { zValidator } from "@hono/zod-validator";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";

import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { toJsonSafe } from "../json.ts";
import {
  activityQuery,
  chainParam,
  decodeCursor,
  encodeCursor,
  listQuery,
  mandateParam,
  seriesQuery,
} from "./params.ts";
import * as q from "./queries.ts";

export interface AppDeps {
  readonly db: Db;
  readonly cache: Cache;
  readonly config: Config;
  readonly log?: (message: string) => void;
}

/** Public, read-mostly API. Every response carries the block it reflects (`head`) for provenance. */
export function createApp(deps: AppDeps) {
  const { db, cache, config } = deps;
  const log = deps.log ?? ((message: string) => console.error(`[api] ${message}`));
  const app = new Hono();

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => (config.API_CORS_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["content-type"],
      maxAge: 600,
    }),
  );
  app.use("*", bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }));

  app.onError((error, c) => {
    log(`${c.req.method} ${c.req.path}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  /** Head for a chain: Redis first, Postgres cursor as fallback. Undefined if the chain is not indexed. */
  async function head(chainId: number) {
    const cached = await cache.getHead(chainId);
    if (cached) return cached;
    const cursor = await q.getCursor(db, chainId);
    return cursor ? { number: cursor.blockNumber.toString(), hash: cursor.blockHash } : undefined;
  }

  /** Serves `compute()` from the head-scoped response cache. A new head is a new key, so no stale reads. */
  async function cached(c: Context, chainId: number, route: string, compute: () => Promise<unknown>) {
    const at = await head(chainId);
    if (!at) return c.json({ error: "chain not indexed" }, 404);
    const key = keys.response(chainId, at.hash, route);
    const hit = await cache.getJson<unknown>(key);
    if (hit !== undefined) {
      c.header("x-cache", "hit");
      return c.json(hit as object);
    }
    const body = toJsonSafe({ head: at, data: await compute() });
    if ((body as { data: unknown }).data === null) return c.json({ error: "not found", head: at }, 404);
    await cache.setJson(key, body, TTL.responseSeconds);
    c.header("x-cache", "miss");
    return c.json(body as object);
  }

  /** Validation failure response: lists messages only, never echoes the raw input. */
  const invalid = (result: { success: boolean; error?: { issues: readonly { message: string }[] } }, c: Context) => {
    if (!result.success) return c.json({ error: "invalid request", issues: result.error?.issues.map((i) => i.message) }, 400);
  };

  app.get("/health", async (c) => {
    const dbOk = await q
      .getCursor(db, config.INDEXER_CHAIN_ID)
      .then(() => true)
      .catch(() => false);
    const redisOk = await cache.healthy();
    const at = dbOk ? await head(config.INDEXER_CHAIN_ID) : undefined;
    return c.json({ ok: dbOk, db: dbOk, redis: redisOk, chainId: config.INDEXER_CHAIN_ID, head: at ?? null }, dbOk ? 200 : 503);
  });

  app.get("/v1/chains/:chainId/mandates", zValidator("param", chainParam, invalid), zValidator("query", listQuery, invalid), async (c) => {
    const { chainId } = c.req.valid("param");
    const filter = c.req.valid("query");
    return cached(c, chainId, `mandates?safe=${filter.safe ?? ""}&mm=${filter.mm ?? ""}`, () =>
      q.listMandates(db, chainId, filter),
    );
  });

  app.get("/v1/chains/:chainId/mandates/:mandateId", zValidator("param", mandateParam, invalid), async (c) => {
    const { chainId, mandateId } = c.req.valid("param");
    return cached(c, chainId, `mandate:${mandateId}`, async () => {
      const mandate = await q.getMandate(db, chainId, mandateId);
      if (!mandate) return null;
      const chain = await q.getChain(db, chainId);
      return {
        mandate,
        snapshot: (await q.latestSnapshot(db, chainId, mandateId)) ?? null,
        chain: chain ? { environment: chain.environment, sourceChainId: chain.sourceChainId } : null,
      };
    });
  });

  app.get(
    "/v1/chains/:chainId/mandates/:mandateId/activity",
    zValidator("param", mandateParam, invalid),
    zValidator("query", activityQuery, invalid),
    async (c) => {
      const { chainId, mandateId } = c.req.valid("param");
      const { limit, before } = c.req.valid("query");
      const cursor = before ? decodeCursor(before) : null;
      if (before && !cursor) return c.json({ error: "invalid cursor" }, 400);
      return cached(c, chainId, `activity:${mandateId}:${limit}:${before ?? ""}`, async () => {
        const rows = await q.activity(db, chainId, mandateId, { limit, before: cursor });
        const last = rows.at(-1);
        return {
          items: rows,
          next:
            rows.length === limit && last
              ? encodeCursor({ blockNumber: BigInt(last.block_number), ord: Number(last.ord), key: last.key })
              : null,
        };
      });
    },
  );

  app.get(
    "/v1/chains/:chainId/mandates/:mandateId/series",
    zValidator("param", mandateParam, invalid),
    zValidator("query", seriesQuery, invalid),
    async (c) => {
      const { chainId, mandateId } = c.req.valid("param");
      const range = c.req.valid("query");
      return cached(c, chainId, `series:${mandateId}:${range.fromBlock ?? ""}:${range.toBlock ?? ""}:${range.limit}`, () =>
        q.series(db, chainId, mandateId, range),
      );
    },
  );

  return app;
}

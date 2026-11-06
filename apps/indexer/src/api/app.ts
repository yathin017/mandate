import { getConnInfo } from "@hono/node-server/conninfo";

import { zValidator } from "@hono/zod-validator";
import { sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { streamSSE } from "hono/streaming";

import { createAuthRoutes } from "../auth/routes.ts";
import { createProfileRoutes } from "../marketplace/profiles.ts";
import { createProposalRoutes } from "../marketplace/proposals.ts";
import { loadEvidence } from "../score/evidence.ts";
import { computeScores, WEIGHTS, WINDOW_SECONDS } from "../score/score.ts";
import { rateLimit } from "./rateLimit.ts";
import type { Cache } from "../cache/cache.ts";
import type { ChainContext } from "../chain.ts";
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
  launchedQuery,
  mandateParam,
  mmParam,
  seriesQuery,
} from "./params.ts";
import * as q from "./queries.ts";
import { attemptBody, simulateAttempt } from "./simulate.ts";

export interface AppDeps {
  readonly db: Db;
  readonly cache: Cache;
  readonly config: Config;
  readonly log?: (message: string) => void;
  /** Lazily connects to the indexed chain's RPC; only simulated attempts need it. */
  readonly chain?: () => Promise<ChainContext>;
  /** Client identity for rate limiting. Defaults to the socket address; proxy headers are never trusted. */
  readonly clientIp?: (c: Context) => string;
  /** Max concurrent SSE streams per process (default 500). */
  readonly maxStreams?: number;
  /** SSE heartbeat interval (default 15s). */
  readonly heartbeatMs?: number;
}

/** Public, read-mostly API. Every response carries the block it reflects (`head`) for provenance. */
export function createApp(deps: AppDeps) {
  const { db, cache, config } = deps;
  const log = deps.log ?? ((message: string) => console.error(`[api] ${message}`));
  const app = new Hono();
  const clientIp =
    deps.clientIp ??
    ((c: Context) => {
      try {
        return getConnInfo(c).remote.address ?? "unknown";
      } catch {
        return "unknown";
      }
    });

  app.use("*", secureHeaders());
  app.use(
    "*",
    cors({
      origin: (origin) => (config.API_CORS_ORIGINS.includes(origin) ? origin : null),
      allowMethods: ["GET", "POST", "PUT", "OPTIONS"],
      allowHeaders: ["content-type"],
      // Session cookies; origins are an explicit allow-list, never reflected wildcards.
      credentials: true,
      maxAge: 600,
    }),
  );
  // Sign-in bodies may carry ERC-6492 smart-wallet signatures; every other body stays small.
  const smallBody = bodyLimit({ maxSize: 4 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) });
  const signInBody = bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) });
  app.use("*", (c, next) => (c.req.path === "/v1/auth/verify" ? signInBody(c, next) : smallBody(c, next)));

  app.onError((error, c) => {
    log(`${c.req.method} ${c.req.path}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    return c.json({ error: "internal error" }, 500);
  });
  app.notFound((c) => c.json({ error: "not found" }, 404));

  const chainDep = deps.chain ? { chain: deps.chain } : {};
  app.route("/v1/auth", createAuthRoutes({ db, cache, config, log, clientIp, ...chainDep }));
  app.route("/v1/mms", createProfileRoutes({ db, cache, config, clientIp }));
  app.route("/v1/proposals", createProposalRoutes({ db, cache, config, log, clientIp, ...chainDep }));

  /** Head for a chain: Redis first, Postgres cursor as fallback. Undefined if the chain is not indexed. */
  async function head(chainId: number) {
    const cached = await cache.getHead(chainId);
    if (cached) return cached;
    const cursor = await q.getCursor(db, chainId);
    return cursor ? { number: cursor.blockNumber.toString(), hash: cursor.blockHash } : undefined;
  }

  /**
   * `{ head, data }` for `compute()` from the head-scoped response cache. A new head is a new key, so no stale
   * reads. Undefined when the chain is not indexed.
   */
  async function cachedBody(chainId: number, route: string, compute: () => Promise<unknown>) {
    const at = await head(chainId);
    if (!at) return undefined;
    const key = keys.response(chainId, at.hash, route);
    const hit = await cache.getJson<{ head: typeof at; data: unknown }>(key);
    if (hit !== undefined) return { body: hit, hit: true };
    const body = toJsonSafe({ head: at, data: await compute() }) as { head: typeof at; data: unknown };
    if (body.data !== null) await cache.setJson(key, body, TTL.responseSeconds);
    return { body, hit: false };
  }

  /** Serves `compute()` through `cachedBody`; null data is a 404. */
  async function cached(c: Context, chainId: number, route: string, compute: () => Promise<unknown>) {
    const result = await cachedBody(chainId, route, compute);
    if (!result) return c.json({ error: "chain not indexed" }, 404);
    if (result.body.data === null) return c.json({ error: "not found", head: result.body.head }, 404);
    c.header("x-cache", result.hit ? "hit" : "miss");
    return c.json(result.body as object);
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
    return cached(c, chainId, `mandates?safe=${filter.safe ?? ""}&mm=${filter.mm ?? ""}`, async () => {
      const rows = await q.listMandates(db, chainId, filter);
      const tokens = await q.tokenMap(db, chainId, rows.flatMap((row) => [row.base, row.quote]));
      return rows.map((row) => ({ ...row, tokens: { base: tokens[row.base] ?? null, quote: tokens[row.quote] ?? null } }));
    });
  });

  /** Market-maker scores at the indexed head (onchain evidence only; see src/score/score.ts). */
  async function scoresAt(chainId: number) {
    const at = await head(chainId);
    if (!at) return [];
    const [block] = await db.execute<{ timestamp: string }>(sql`SELECT timestamp::text FROM blocks WHERE chain_id = ${chainId} AND hash = ${at.hash}`);
    if (!block) return [];
    const now = BigInt(block.timestamp);
    return computeScores(await loadEvidence(db, chainId, now)).map((s) => ({
      ...s,
      window: { from: (now - BigInt(WINDOW_SECONDS)).toString(), to: now.toString() },
    }));
  }

  const allScores = (chainId: number) => cachedBody(chainId, "mm-scores", async () => ({ weights: WEIGHTS, scores: await scoresAt(chainId) }));

  app.get("/v1/chains/:chainId/mms/scores", zValidator("param", chainParam, invalid), async (c) => {
    const result = await allScores(c.req.valid("param").chainId);
    return result ? c.json(result.body) : c.json({ error: "chain not indexed" }, 404);
  });

  app.get("/v1/chains/:chainId/mms/:address/score", zValidator("param", mmParam, invalid), async (c) => {
    const { chainId, address } = c.req.valid("param");
    const result = await allScores(chainId);
    if (!result) return c.json({ error: "chain not indexed" }, 404);
    const { scores } = result.body.data as { scores: { mm: string }[] };
    const score = scores.find((s) => s.mm === address.toLowerCase());
    return score ? c.json({ head: result.body.head, data: { weights: WEIGHTS, ...score } }) : c.json({ error: "no mandates for this market maker" }, 404);
  });

  app.get("/v1/chains/:chainId/tokens/launched", zValidator("param", chainParam, invalid), zValidator("query", launchedQuery, invalid), async (c) => {
    const { chainId } = c.req.valid("param");
    const filter = c.req.valid("query");
    return cached(c, chainId, `launched?creator=${filter.creator ?? ""}&recipient=${filter.recipient ?? ""}`, () =>
      q.listLaunchedTokens(db, chainId, filter),
    );
  });

  app.get("/v1/chains/:chainId/mandates/:mandateId", zValidator("param", mandateParam, invalid), async (c) => {
    const { chainId, mandateId } = c.req.valid("param");
    return cached(c, chainId, `mandate:${mandateId}`, async () => {
      const mandate = await q.getMandate(db, chainId, mandateId);
      if (!mandate) return null;
      const chain = await q.getChain(db, chainId);
      const tokens = await q.tokenMap(db, chainId, [mandate.base, mandate.quote]);
      return {
        mandate,
        tokens: { base: tokens[mandate.base] ?? null, quote: tokens[mandate.quote] ?? null },
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
      // Simulated attempts do not move the head, so the feed key also carries the mandate's write version.
      const version = await cache.getMandateVersion(chainId, mandateId);
      return cached(c, chainId, `activity:${mandateId}:v${version}:${limit}:${before ?? ""}`, async () => {
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

  let openStreams = 0;
  const maxStreams = deps.maxStreams ?? 500;
  const heartbeatMs = deps.heartbeatMs ?? 15_000;

  /**
   * Server-sent events for one mandate: `ready` with the current head, then `change` after every committed
   * batch or simulated attempt that touches it. Clients refetch the REST resources on `change`.
   */
  app.get("/v1/chains/:chainId/mandates/:mandateId/stream", zValidator("param", mandateParam, invalid), async (c) => {
    const { chainId, mandateId } = c.req.valid("param");
    const at = await head(chainId);
    if (!at) return c.json({ error: "chain not indexed" }, 404);
    if (!(await q.getMandate(db, chainId, mandateId))) return c.json({ error: "not found" }, 404);
    if (openStreams >= maxStreams) return c.json({ error: "too many streams" }, 503);

    const queue: string[] = [];
    let wake: (() => void) | undefined;
    let unsubscribe: () => void;
    try {
      unsubscribe = await cache.subscribe(chainId, mandateId, (change) => {
        queue.push(JSON.stringify(change));
        wake?.();
      });
    } catch {
      return c.json({ error: "live updates unavailable" }, 503);
    }

    openStreams++;
    return streamSSE(c, async (stream) => {
      let closed = false;
      const stop = () => {
        closed = true;
        wake?.();
      };
      // Either signal may fire first depending on the adapter; both end the loop and free the slot.
      stream.onAbort(stop);
      c.req.raw.signal.addEventListener("abort", stop, { once: true });
      try {
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ head: at }) });
        while (!closed) {
          while (queue.length) await stream.writeSSE({ event: "change", data: queue.shift()! });
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, heartbeatMs).unref();
          });
          wake = undefined;
          if (!closed && !queue.length) await stream.writeSSE({ event: "heartbeat", data: "{}" });
        }
      } finally {
        openStreams--;
        unsubscribe();
      }
    });
  });

  app.post(
    "/v1/chains/:chainId/mandates/:mandateId/attempts",
    zValidator("param", mandateParam, invalid),
    zValidator("json", attemptBody, invalid),
    // Each request costs RPC calls.
    rateLimit({ cache, scope: "attempts", perMinute: config.API_ATTEMPTS_PER_MINUTE, clientIp, unavailable: "rate limiter unavailable" }),
    async (c) => {
      const { chainId, mandateId } = c.req.valid("param");
      if (chainId !== config.INDEXER_CHAIN_ID || !deps.chain) return c.json({ error: "chain not simulated here" }, 404);

      let chain: ChainContext;
      try {
        chain = await deps.chain();
      } catch (error) {
        log(`chain unavailable: ${error instanceof Error ? error.message : String(error)}`);
        return c.json({ error: "chain RPC unavailable" }, 503);
      }
      const result = await simulateAttempt({ db, cache, chain }, mandateId, c.req.valid("json"));
      if (result.status === "not-found") return c.json({ error: result.message }, 404);
      if (result.status === "stale-head") return c.json({ error: result.message }, 409);
      const at = await head(chainId);
      return c.json({ head: at, data: result.body as object }, 201);
    },
  );

  return app;
}

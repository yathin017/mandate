import type { Context, MiddlewareHandler } from "hono";

import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";

/**
 * Fixed one-minute window per client and scope, counted in Redis. Fails closed (503) when Redis is unavailable:
 * every limited route either costs RPC calls or writes data.
 */
export function rateLimit(input: {
  cache: Cache;
  scope: string;
  perMinute: number;
  clientIp: (c: Context) => string;
  unavailable?: string;
}): MiddlewareHandler {
  return async (c, next) => {
    const window = Math.floor(Date.now() / 60_000);
    const hits = await input.cache.hit(keys.rateLimit(input.scope, input.clientIp(c), window), TTL.rateLimitSeconds);
    if (hits === undefined) return c.json({ error: input.unavailable ?? "service unavailable" }, 503);
    if (hits > input.perMinute) {
      c.header("retry-after", String(60 - (Math.floor(Date.now() / 1000) % 60)));
      return c.json({ error: "too many requests" }, 429);
    }
    await next();
  };
}

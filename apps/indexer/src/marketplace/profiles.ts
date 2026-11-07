import { zValidator } from "@hono/zod-validator";
import { desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";

import { rateLimit } from "../api/rateLimit.ts";
import { requireAllowedOrigin, requireSession, type AuthEnv } from "../auth/routes.ts";
import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { mmProfiles } from "../db/schema.ts";

/**
 * Market-maker listings.
 *
 *   GET /v1/mms              listed profiles (public, cached)
 *   GET /v1/mms/:address     one profile, listed or not (public)
 *   PUT /v1/mms/me           create or replace the signed-in wallet's own profile
 *
 * Text is user-supplied and shown to others: control characters are stripped, lengths are capped, the website must
 * be an https URL, and nothing here is ever rendered as HTML by the web app.
 */
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
// Strip control characters (including newlines in single-line fields) before length checks.
const line = (max: number) => z.string().transform((v) => v.replace(/[\p{Cc}\p{Cf}]/gu, "").trim()).pipe(z.string().max(max));
const text = (max: number) =>
  z.string().transform((v) => v.replace(/[^\P{Cc}\n]|\p{Cf}/gu, "").trim()).pipe(z.string().max(max));

export const profileBody = z.object({
  displayName: line(64).pipe(z.string().min(1)),
  bio: text(1000).default(""),
  website: z
    .string()
    .trim()
    .max(200)
    .refine((v) => {
      try {
        return new URL(v).protocol === "https:";
      } catch {
        return false;
      }
    }, "website must be an https URL")
    .nullable()
    .default(null),
  contact: line(100).nullable().default(null),
  coverage: z.array(line(32).pipe(z.string().min(1))).max(10).default([]),
  minDealUsd: z.number().int().min(0).max(1_000_000_000_000).nullable().default(null),
  listed: z.boolean().default(true),
});

const columns = {
  address: mmProfiles.address,
  displayName: mmProfiles.displayName,
  bio: mmProfiles.bio,
  website: mmProfiles.website,
  contact: mmProfiles.contact,
  coverage: mmProfiles.coverage,
  minDealUsd: mmProfiles.minDealUsd,
  listed: mmProfiles.listed,
  updatedAt: mmProfiles.updatedAt,
};

export function createProfileRoutes(deps: { db: Db; cache: Cache; config: Config; clientIp: (c: Context) => string }) {
  const { db, cache, config } = deps;
  const app = new Hono<AuthEnv>();
  const invalid = (result: { success: boolean; error?: { issues: readonly { message: string }[] } }, c: Context) => {
    if (!result.success) return c.json({ error: "invalid request", issues: result.error?.issues.map((i) => i.message) }, 400);
  };

  app.get("/", async (c) => {
    const hit = await cache.getJson<unknown>(keys.mmList());
    if (hit !== undefined) return c.json({ data: hit });
    const rows = await db.select(columns).from(mmProfiles).where(eq(mmProfiles.listed, true)).orderBy(desc(mmProfiles.updatedAt)).limit(500);
    await cache.setJson(keys.mmList(), rows, TTL.mmListSeconds);
    return c.json({ data: rows });
  });

  app.put(
    "/me",
    requireAllowedOrigin(config),
    rateLimit({ cache, scope: "profile", perMinute: 20, clientIp: deps.clientIp }),
    requireSession(deps),
    zValidator("json", profileBody, invalid),
    async (c) => {
      const body = c.req.valid("json");
      const address = c.var.session.address.toLowerCase();
      const values = { ...body, coverage: [...new Set(body.coverage)] };
      const [row] = await db
        .insert(mmProfiles)
        .values({ address, ...values })
        .onConflictDoUpdate({ target: mmProfiles.address, set: { ...values, updatedAt: sql`now()` } })
        .returning(columns);
      await cache.delete(keys.mmList());
      return c.json({ data: row });
    },
  );

  app.get("/:address", async (c) => {
    const address = c.req.param("address");
    if (!ADDRESS.test(address)) return c.json({ error: "invalid address" }, 400);
    const [row] = await db.select(columns).from(mmProfiles).where(eq(mmProfiles.address, address.toLowerCase())).limit(1);
    return row ? c.json({ data: row }) : c.json({ error: "not found" }, 404);
  });

  return app;
}

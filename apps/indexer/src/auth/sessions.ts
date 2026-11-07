import { createHash, randomBytes } from "node:crypto";

import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { Address } from "viem";

import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";
import type { Db } from "../db/client.ts";
import { accounts, authSessions } from "../db/schema.ts";

/** What a request learns about its caller once the session cookie checks out. */
export interface Session {
  readonly id: string;
  readonly address: Address;
  readonly chainId: number;
  readonly expiresAt: string;
}

/** 256-bit random cookie token. Only its SHA-256 is ever stored. */
export function newSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return `0x${createHash("sha256").update(token).digest("hex")}`;
}

/** Records the account (first sign-in) or its latest sign-in, then opens a session. */
export async function openSession(
  db: Db,
  input: { token: string; address: Address; chainId: number; ttlHours: number },
): Promise<Session> {
  const address = input.address.toLowerCase() as Address;
  const expiresAt = new Date(Date.now() + input.ttlHours * 3_600_000);
  return db.transaction(async (tx) => {
    await tx
      .insert(accounts)
      .values({ address })
      .onConflictDoUpdate({ target: accounts.address, set: { lastSignInAt: sql`now()` } });
    const [row] = await tx
      .insert(authSessions)
      .values({ tokenHash: hashToken(input.token), address, chainId: input.chainId, expiresAt })
      .returning({ id: authSessions.id });
    return { id: row!.id, address, chainId: input.chainId, expiresAt: expiresAt.toISOString() };
  });
}

/**
 * Resolves a cookie token to a live session: Redis first (short TTL), Postgres as the source of truth.
 * Expired or revoked sessions resolve to undefined.
 */
export async function findSession(db: Db, cache: Cache, token: string): Promise<Session | undefined> {
  const tokenHash = hashToken(token);
  const hit = await cache.getJson<Session>(keys.session(tokenHash));
  if (hit && Date.parse(hit.expiresAt) > Date.now()) return hit;

  const [row] = await db
    .select({ id: authSessions.id, address: authSessions.address, chainId: authSessions.chainId, expiresAt: authSessions.expiresAt })
    .from(authSessions)
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt), gt(authSessions.expiresAt, sql`now()`)))
    .limit(1);
  if (!row) return undefined;
  const session: Session = { id: row.id, address: row.address as Address, chainId: row.chainId, expiresAt: row.expiresAt.toISOString() };
  const ttl = Math.min(TTL.sessionSeconds, Math.floor((row.expiresAt.getTime() - Date.now()) / 1000));
  if (ttl > 0) await cache.setJson(keys.session(tokenHash), session, ttl);
  return session;
}

/**
 * Ends a session now: revoked in Postgres first, then the cached lookup is dropped. A lookup racing the sign-out
 * can re-cache it for at most `TTL.sessionSeconds`.
 */
export async function revokeSession(db: Db, cache: Cache, token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await db
    .update(authSessions)
    .set({ revokedAt: sql`now()` })
    .where(and(eq(authSessions.tokenHash, tokenHash), isNull(authSessions.revokedAt)));
  await cache.delete(keys.session(tokenHash));
}

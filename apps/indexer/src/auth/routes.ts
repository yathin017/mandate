import { zValidator } from "@hono/zod-validator";
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAddress, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, verifySiweMessage } from "viem/siwe";
import { z } from "zod";

import type { Cache } from "../cache/cache.ts";
import { keys, TTL } from "../cache/keys.ts";
import type { ChainContext } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { findSession, newSessionToken, openSession, revokeSession, type Session } from "./sessions.ts";

/**
 * Sign-In with Ethereum (EIP-4361) for the platform's off-chain features (market-maker profiles, proposals).
 *
 *   GET  /v1/auth/nonce    one-time nonce (Redis, 10 min) + the chain and statement the message must use
 *   POST /v1/auth/verify   { message, signature } → session cookie
 *   GET  /v1/auth/session  the caller's session, or 401
 *   POST /v1/auth/logout   revokes the session and clears the cookie
 *
 * The message must name an allowed web origin (domain + URI), the indexed chain and a nonce issued here; the nonce
 * is consumed before the signature is checked, so each signed message works at most once. Signatures are verified
 * through the chain RPC, so EOAs, deployed smart wallets (ERC-1271) and counterfactual ones (ERC-6492) all work.
 * The session cookie is HttpOnly, SameSite=Strict and (by default) Secure with the `__Host-` prefix; state-changing
 * auth requests must also send an allowed Origin header.
 */
export const SIWE_STATEMENT = "Sign in to Mandate. This request does not send a transaction or cost gas.";
const COOKIE = "mandate_session";
/** A signed message older than this is refused even if its nonce is still live. */
const MAX_MESSAGE_AGE_MS = TTL.authNonceSeconds * 1000;
const CLOCK_SKEW_MS = 60_000;

export interface AuthDeps {
  readonly db: Db;
  readonly cache: Cache;
  readonly config: Config;
  readonly chain?: () => Promise<ChainContext>;
  readonly clientIp: (c: Context) => string;
  readonly log: (message: string) => void;
}

export type AuthEnv = { Variables: { session: Session } };

const verifyBody = z.object({
  message: z.string().min(1).max(2_000),
  // ERC-6492 signatures (undeployed smart wallets) carry deployment calldata, so they can run to kilobytes.
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/).max(12_000),
});

/** Secure cookies use the `__Host-` prefix: no Domain attribute, Path=/, Secure, so subdomains cannot set them. */
const cookiePrefix = (config: Config) => (config.API_SESSION_COOKIE_SECURE ? ("host" as const) : undefined);
const cookieOptions = (config: Config) => (cookiePrefix(config) ? { prefix: "host" as const } : {});

/** Reads the caller's session from the cookie, if any. */
export async function sessionOf(c: Context, deps: Pick<AuthDeps, "db" | "cache" | "config">): Promise<Session | undefined> {
  const token = getCookie(c, COOKIE, cookiePrefix(deps.config));
  if (!token || token.length > 64) return undefined;
  return findSession(deps.db, deps.cache, token);
}

/** For later routes that act on behalf of a wallet: 401 without a live session, else `c.var.session`. */
export function requireSession(deps: Pick<AuthDeps, "db" | "cache" | "config">): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const session = await sessionOf(c, deps);
    if (!session) return c.json({ error: "sign in required" }, 401);
    c.set("session", session);
    await next();
  };
}

/** Rejects state-changing requests whose Origin is not an allowed web origin (CSRF defence beside SameSite). */
export function requireAllowedOrigin(config: Config): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (!origin || !config.API_AUTH_ORIGINS.includes(origin)) return c.json({ error: "origin not allowed" }, 403);
    await next();
  };
}

export function createAuthRoutes(deps: AuthDeps) {
  const { db, cache, config, log } = deps;
  const app = new Hono<AuthEnv>();

  app.use("*", async (c, next) => {
    if (config.API_AUTH_ORIGINS.length === 0) return c.json({ error: "sign-in is not configured" }, 503);
    await next();
  });

  /** Fixed one-minute window per client on the sign-in steps; fails closed because nonces need Redis anyway. */
  const limit: MiddlewareHandler<AuthEnv> = async (c, next) => {
    const window = Math.floor(Date.now() / 60_000);
    const hits = await cache.hit(keys.rateLimit("auth", deps.clientIp(c), window), TTL.rateLimitSeconds);
    if (hits === undefined) return c.json({ error: "sign-in unavailable" }, 503);
    if (hits > config.API_AUTH_PER_MINUTE) {
      c.header("retry-after", String(60 - (Math.floor(Date.now() / 1000) % 60)));
      return c.json({ error: "too many requests" }, 429);
    }
    await next();
  };

  app.get("/nonce", limit, async (c) => {
    const nonce = generateSiweNonce();
    if (!(await cache.putNonce(nonce))) return c.json({ error: "sign-in unavailable" }, 503);
    c.header("cache-control", "no-store");
    return c.json({ nonce, chainId: config.INDEXER_CHAIN_ID, statement: SIWE_STATEMENT, expiresInSeconds: TTL.authNonceSeconds });
  });

  app.post(
    "/verify",
    limit,
    requireAllowedOrigin(config),
    zValidator("json", verifyBody, (result, c) => {
      if (!result.success) return c.json({ error: "invalid request" }, 400);
    }),
    async (c) => {
      const { message, signature } = c.req.valid("json");
      const refuse = (reason: string) => c.json({ error: reason }, 401);

      let fields: ReturnType<typeof parseSiweMessage>;
      try {
        fields = parseSiweMessage(message);
      } catch {
        return refuse("malformed sign-in message");
      }
      const { domain, uri, address, chainId, nonce, issuedAt, expirationTime, notBefore, version, statement } = fields;
      if (version !== "1" || !domain || !uri || !address || !nonce || !issuedAt) return refuse("incomplete sign-in message");
      let uriOrigin: string;
      try {
        uriOrigin = new URL(uri).origin;
      } catch {
        return refuse("invalid URI");
      }
      // The web origin that asked for the signature must be an allowed one, and the message must name it.
      const origin = c.req.header("origin")!;
      if (uriOrigin !== origin || domain !== new URL(origin).host) return refuse("message is for another site");
      if (chainId !== config.INDEXER_CHAIN_ID) return refuse("message is for another chain");
      if (statement !== SIWE_STATEMENT) return refuse("unexpected statement");
      const now = Date.now();
      if (issuedAt.getTime() > now + CLOCK_SKEW_MS || now - issuedAt.getTime() > MAX_MESSAGE_AGE_MS) return refuse("message expired");
      if (expirationTime && expirationTime.getTime() <= now) return refuse("message expired");
      if (notBefore && notBefore.getTime() > now + CLOCK_SKEW_MS) return refuse("message not yet valid");

      // One use per nonce, consumed before the (RPC-backed) signature check so replays cannot race it.
      const fresh = await cache.takeNonce(nonce);
      if (fresh === undefined) return c.json({ error: "sign-in unavailable" }, 503);
      if (!fresh) return refuse("unknown or used nonce");

      if (!deps.chain) return c.json({ error: "sign-in unavailable" }, 503);
      let valid: boolean;
      try {
        const { client } = await deps.chain();
        valid = await verifySiweMessage(client, { message, signature: signature as Hex, domain, nonce, address });
      } catch (error) {
        log(`siwe verification failed: ${error instanceof Error ? error.message : String(error)}`);
        return c.json({ error: "chain RPC unavailable" }, 503);
      }
      if (!valid) return refuse("invalid signature");

      const token = newSessionToken();
      const session = await openSession(db, { token, address: getAddress(address), chainId, ttlHours: config.API_SESSION_TTL_HOURS });
      setCookie(c, COOKIE, token, {
        httpOnly: true,
        secure: config.API_SESSION_COOKIE_SECURE,
        sameSite: "Strict",
        path: "/",
        maxAge: config.API_SESSION_TTL_HOURS * 3600,
        ...cookieOptions(config),
      });
      return c.json({ data: session });
    },
  );

  app.get("/session", async (c) => {
    c.header("cache-control", "no-store");
    const session = await sessionOf(c, deps);
    return session ? c.json({ data: session }) : c.json({ error: "not signed in" }, 401);
  });

  app.post("/logout", requireAllowedOrigin(config), async (c) => {
    const token = getCookie(c, COOKIE, cookiePrefix(config));
    if (token && token.length <= 64) await revokeSession(db, cache, token);
    deleteCookie(c, COOKIE, { path: "/", secure: config.API_SESSION_COOKIE_SECURE, ...cookieOptions(config) });
    return c.body(null, 204);
  });

  return app;
}

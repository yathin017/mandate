import postgres from "postgres";

import { Cache } from "./cache/cache.ts";

/**
 * Startup checks that turn missing infrastructure into one actionable line instead of a driver stack trace.
 * Connection strings are printed without credentials.
 */

export class PreflightError extends Error {}

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch {
    return "<invalid url>";
  }
}

export async function checkPostgres(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new PreflightError(
      `Cannot reach Postgres at ${redact(url)} (${reason}). Start it with \`pnpm infra:up\`, or fix DATABASE_URL in .env.`,
    );
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** The API reads tables the worker creates; only the worker runs migrations, so two processes never race. */
export async function checkSchema(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    const [row] = await sql`select to_regclass('public.sync_cursors') is not null as ready`;
    if (!row?.ready) {
      throw new PreflightError("Database has no indexer schema yet. Start the worker first (`pnpm indexer:worker`); it applies migrations.");
    }
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/** Redis is a cache: its absence is a warning, never fatal. */
export async function checkRedis(url: string, warn: (message: string) => void): Promise<void> {
  const cache = await Cache.connect(url);
  const ok = await cache.healthy();
  await cache.close();
  if (!ok) warn(`Redis at ${redact(url)} is unreachable; continuing without cache. Start it with \`pnpm infra:up\`.`);
}

export async function checkRpc(url: string, expectedChainId: number): Promise<void> {
  let chainId: number;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(3000),
    });
    const body = (await response.json()) as { result?: string };
    chainId = Number(body.result);
  } catch {
    throw new PreflightError(
      `Cannot reach the chain RPC at ${redact(url)}. For the demo, start the fork with \`pnpm replay:serve\` and keep it running.`,
    );
  }
  if (chainId !== expectedChainId) {
    throw new PreflightError(`RPC at ${redact(url)} is chain ${chainId}, but INDEXER_CHAIN_ID is ${expectedChainId}.`);
  }
}

/** Runs `main`, printing preflight failures as a single line and exiting non-zero. */
export async function runWithPreflight(name: string, main: () => Promise<void>): Promise<void> {
  try {
    await main();
  } catch (error) {
    if (error instanceof PreflightError) {
      console.error(`[${name}] ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}

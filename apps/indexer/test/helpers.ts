import { readFile } from "node:fs/promises";

import postgres from "postgres";

import { loadConfig, type Config } from "../src/config.ts";
import { runMigrations } from "../src/db/migrate.ts";

/**
 * Integration tests need a live demo chain (`pnpm replay:serve`) and a disposable Postgres database.
 * They are skipped unless INDEXER_TEST_DATABASE_URL is set. The test database is wiped on every run.
 */
export const testDatabaseUrl = process.env.INDEXER_TEST_DATABASE_URL;
export const skip = testDatabaseUrl ? false : "set INDEXER_TEST_DATABASE_URL (and run `pnpm replay:serve`)";

export function testConfig(overrides: Partial<Record<string, string>> = {}): Config {
  return loadConfig({
    DATABASE_URL: testDatabaseUrl,
    REDIS_URL: process.env.INDEXER_TEST_REDIS_URL ?? process.env.REDIS_URL ?? "redis://127.0.0.1:6379",
    INDEXER_RPC_URL: process.env.INDEXER_RPC_URL ?? "http://127.0.0.1:8547",
    INDEXER_CHAIN_ID: "31337",
    INDEXER_CONFIRMATIONS: "0",
    INDEXER_LOG_RANGE: "50",
    API_CORS_ORIGINS: "http://localhost:5173",
    API_ATTEMPTS_PER_MINUTE: "3",
    ...overrides,
  });
}

/** Drops and recreates the schema, then applies migrations. */
export async function resetDatabase(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql.unsafe("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS drizzle CASCADE; CREATE SCHEMA public;");
  await sql.end();
  await runMigrations(url);
}

export interface ReplayStep {
  kind: string;
  outcome: "executed" | "blocked";
  target: string;
}
export interface ReplayAct {
  act: number;
  mandateId: string;
  steps: ReplayStep[];
}

export async function loadReplay(): Promise<{ acts: ReplayAct[] }> {
  return JSON.parse(await readFile(new URL("../../../replay/data/acts.json", import.meta.url), "utf8"));
}

export async function rpc<T>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/** Resets the test database and indexes the live demo chain up to its head. */
export async function indexDemoChain(config: Config) {
  const [{ createDb }, { createChainContext }, { Indexer }] = await Promise.all([
    import("../src/db/client.ts"),
    import("../src/chain.ts"),
    import("../src/ingest/indexer.ts"),
  ]);
  await resetDatabase(config.DATABASE_URL);
  const handle = createDb(config.DATABASE_URL);
  const ctx = await createChainContext(config);
  const indexer = new Indexer(ctx, handle.db, config, () => {}, () => {});
  await indexer.init();
  while (await indexer.step()) {
    /* index to head */
  }
  return { ...handle, ctx, indexer };
}

/** Web origin the auth tests sign in from. */
export const TEST_WEB_ORIGIN = "http://localhost:5173";

/** Signs in through the API with a local account; returns the session cookie for later requests. */
export async function signIn(
  app: { request: (path: string, init?: RequestInit) => Response | Promise<Response> },
  account: { address: `0x${string}`; signMessage: (args: { message: string }) => Promise<`0x${string}`> },
  chainId: number,
): Promise<string> {
  const [{ createSiweMessage }, { SIWE_STATEMENT }] = await Promise.all([import("viem/siwe"), import("../src/auth/routes.ts")]);
  const { nonce } = (await (await app.request("/v1/auth/nonce")).json()) as { nonce: string };
  const message = createSiweMessage({
    address: account.address, chainId, domain: new URL(TEST_WEB_ORIGIN).host, uri: TEST_WEB_ORIGIN, nonce,
    statement: SIWE_STATEMENT, version: "1", issuedAt: new Date(),
  });
  const response = await app.request("/v1/auth/verify", {
    method: "POST",
    headers: { "content-type": "application/json", origin: TEST_WEB_ORIGIN },
    body: JSON.stringify({ message, signature: await account.signMessage({ message }) }),
  });
  if (response.status !== 200) throw new Error(`sign-in failed: ${response.status} ${await response.text()}`);
  return response.headers.get("set-cookie")!.split(";")[0]!;
}

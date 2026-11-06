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

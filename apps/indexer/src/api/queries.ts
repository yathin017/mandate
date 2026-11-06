import { and, asc, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { chains, mandates, snapshots, syncCursors } from "../db/schema.ts";
import type { ActivityCursor } from "./params.ts";

/** Read-only queries behind the API. All bigint/numeric values come back as strings or bigint. */

export async function getChain(db: Db, chainId: number) {
  const [chain] = await db.select().from(chains).where(eq(chains.chainId, chainId));
  return chain;
}

export async function getCursor(db: Db, chainId: number) {
  const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.chainId, chainId));
  return cursor;
}

export async function listMandates(db: Db, chainId: number, filter: { safe?: string | undefined; mm?: string | undefined }) {
  const conditions: SQL[] = [eq(mandates.chainId, chainId)];
  if (filter.safe) conditions.push(eq(mandates.safe, filter.safe));
  if (filter.mm) conditions.push(eq(mandates.mm, filter.mm));
  return db.select().from(mandates).where(and(...conditions)).orderBy(asc(mandates.createdBlock)).limit(500);
}

export async function getMandate(db: Db, chainId: number, mandateId: string) {
  const [mandate] = await db
    .select()
    .from(mandates)
    .where(and(eq(mandates.chainId, chainId), eq(mandates.mandateId, mandateId)));
  return mandate;
}

export async function latestSnapshot(db: Db, chainId: number, mandateId: string) {
  const [snapshot] = await db
    .select()
    .from(snapshots)
    .where(and(eq(snapshots.chainId, chainId), eq(snapshots.mandateId, mandateId)))
    .orderBy(desc(snapshots.blockNumber))
    .limit(1);
  return snapshot;
}

export async function series(
  db: Db,
  chainId: number,
  mandateId: string,
  range: { fromBlock?: bigint | undefined; toBlock?: bigint | undefined; limit: number },
) {
  const conditions: SQL[] = [eq(snapshots.chainId, chainId), eq(snapshots.mandateId, mandateId)];
  if (range.fromBlock !== undefined) conditions.push(gte(snapshots.blockNumber, range.fromBlock));
  if (range.toBlock !== undefined) conditions.push(lte(snapshots.blockNumber, range.toBlock));
  return db
    .select()
    .from(snapshots)
    .where(and(...conditions))
    .orderBy(asc(snapshots.blockNumber))
    .limit(range.limit);
}

/** Sort position of simulated attempts within their block: after every onchain log. */
export const SIMULATED_ORD = 2_000_000_000;

export type ActivityRow = {
  kind: "fill" | "attempt";
  block_number: string;
  ord: number;
  key: string;
  timestamp: string;
  tx_hash: string | null;
  source: string;
  outcome: string;
  is_sell: boolean | null;
  amount_in: string | null;
  amount_out: string | null;
  price_x36: string | null;
  fee_token: string | null;
  fee_amount: string | null;
  error_name: string | null;
  error_args: unknown;
  explanation: string | null;
  request: unknown;
};

/**
 * Fills and attempts for one mandate, newest first, keyset-paginated on (block, position, key).
 * Allowed onchain attempts duplicate their own fill, so only blocked onchain attempts are listed; simulated
 * attempts are listed with either outcome.
 */
export async function activity(
  db: Db,
  chainId: number,
  mandateId: string,
  page: { limit: number; before: ActivityCursor | null },
): Promise<ActivityRow[]> {
  const before = page.before
    ? sql`WHERE (block_number, ord, key) < (${page.before.blockNumber}, ${page.before.ord}, ${page.before.key})`
    : sql``;
  const result = await db.execute<ActivityRow>(sql`
    SELECT * FROM (
      SELECT 'fill' AS kind, block_number, log_index AS ord, tx_hash || ':' || log_index AS key, timestamp,
             tx_hash, 'onchain' AS source, 'filled' AS outcome, is_sell, amount_in, amount_out, price_x36,
             fee_token, fee_amount, NULL AS error_name, NULL::jsonb AS error_args, NULL AS explanation,
             NULL::jsonb AS request
        FROM fills WHERE chain_id = ${chainId} AND mandate_id = ${mandateId}
      UNION ALL
      SELECT 'attempt', block_number,
             CASE WHEN source = 'simulated' THEN ${SIMULATED_ORD} ELSE log_index END,
             CASE WHEN source = 'simulated' THEN id::text ELSE tx_hash || ':' || log_index END,
             timestamp, tx_hash, source::text, outcome::text, NULL, amount_in, amount_out, NULL, NULL, NULL,
             error_name, error_args, explanation, request
        FROM attempts
       WHERE chain_id = ${chainId} AND mandate_id = ${mandateId}
         AND (source = 'simulated' OR outcome = 'blocked')
    ) AS feed
    ${before}
    ORDER BY block_number DESC, ord DESC, key DESC
    LIMIT ${page.limit}
  `);
  return [...result] as ActivityRow[];
}

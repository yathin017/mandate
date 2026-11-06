import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { chains, launchedTokens, mandates, snapshots, syncCursors, tokens } from "../db/schema.ts";
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

/** Tokens launched through the chain's TokenFactory, newest first. */
export async function listLaunchedTokens(db: Db, chainId: number, filter: { creator?: string | undefined; recipient?: string | undefined }) {
  const conditions: SQL[] = [eq(launchedTokens.chainId, chainId)];
  if (filter.creator) conditions.push(eq(launchedTokens.creator, filter.creator));
  if (filter.recipient) conditions.push(eq(launchedTokens.recipient, filter.recipient));
  return db.select().from(launchedTokens).where(and(...conditions)).orderBy(desc(launchedTokens.blockNumber)).limit(500);
}

/** Display metadata for the given token addresses, keyed by lowercase address. */
export async function tokenMap(db: Db, chainId: number, addresses: readonly string[]) {
  if (!addresses.length) return {};
  const rows = await db
    .select()
    .from(tokens)
    .where(and(eq(tokens.chainId, chainId), inArray(tokens.address, [...new Set(addresses)])));
  return Object.fromEntries(rows.map((row) => [row.address, { symbol: row.symbol, decimals: row.decimals }]));
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
             CASE WHEN source = 'simulated'
                  -- creation time (µs, zero-padded) orders simulations within their block; id breaks ties
                  THEN lpad((extract(epoch FROM created_at) * 1000000)::bigint::text, 20, '0') || ':' || id::text
                  ELSE tx_hash || ':' || log_index END,
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

/**
 * Per-mandate figures for an issuer Safe's overview, from indexed rows only: the latest snapshot (sold, released,
 * today's sales, fees), fill count and quote volume, and refused attempts. Amounts are raw token units.
 */
export async function safeSummary(db: Db, chainId: number, safe: string) {
  const rows = await db.execute<{
    mandate_id: string; status: number; mm: string; base: string; quote: string;
    allotment: string; total_net_sold: string | null; released: string | null; net_sold_this_epoch: string | null;
    epoch_cap: string | null; fees_base: string | null; fees_quote: string | null; claimed_base: string | null;
    claimed_quote: string | null; anchor_status: string | null; fills: number; quote_volume: string; refused: number;
  }>(sql`
    SELECT m.mandate_id, m.status, m.mm, m.base, m.quote, m.bounds->>'allotment' AS allotment,
           s.total_net_sold::text, s.released::text, s.net_sold_this_epoch::text, s.epoch_cap::text,
           s.fees_base::text, s.fees_quote::text, s.claimed_base::text, s.claimed_quote::text, s.anchor_status::text,
           coalesce(f.fills, 0)::int AS fills, coalesce(f.quote_volume, 0)::text AS quote_volume,
           coalesce(a.refused, 0)::int AS refused
    FROM mandates m
    LEFT JOIN LATERAL (
      SELECT * FROM snapshots s WHERE s.chain_id = m.chain_id AND s.mandate_id = m.mandate_id ORDER BY s.block_number DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS fills, sum(CASE WHEN f.is_sell THEN f.amount_in ELSE f.amount_out END) AS quote_volume
      FROM fills f WHERE f.chain_id = m.chain_id AND f.mandate_id = m.mandate_id
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS refused FROM attempts a
      WHERE a.chain_id = m.chain_id AND a.mandate_id = m.mandate_id AND a.outcome = 'blocked'
    ) a ON true
    WHERE m.chain_id = ${chainId} AND m.safe = ${safe}
    ORDER BY m.created_block DESC`);
  return rows.map((r) => ({
    mandateId: r.mandate_id,
    status: r.status,
    mm: r.mm,
    base: r.base,
    quote: r.quote,
    allotment: r.allotment,
    totalNetSold: r.total_net_sold ?? "0",
    released: r.released ?? "0",
    soldToday: r.net_sold_this_epoch ?? "0",
    dailyCap: r.epoch_cap ?? "0",
    feesBase: r.fees_base ?? "0",
    feesQuote: r.fees_quote ?? "0",
    claimedBase: r.claimed_base ?? "0",
    claimedQuote: r.claimed_quote ?? "0",
    anchorStatus: r.anchor_status,
    fills: r.fills,
    quoteVolume: r.quote_volume,
    refused: r.refused,
  }));
}

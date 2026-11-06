import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { chains, launchedTokens, policies, policySnapshots, strategies, strategySnapshots, syncCursors, tokens } from "../db/schema.ts";
import type { Subject } from "../cache/keys.ts";
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

export async function listPolicies(db: Db, chainId: number, filter: { safe?: string | undefined }) {
  const conditions: SQL[] = [eq(policies.chainId, chainId)];
  if (filter.safe) conditions.push(eq(policies.safe, filter.safe));
  return db.select().from(policies).where(and(...conditions)).orderBy(asc(policies.createdBlock)).limit(500);
}

export async function listStrategies(
  db: Db,
  chainId: number,
  filter: { safe?: string | undefined; mm?: string | undefined; policy?: string | undefined },
) {
  const conditions: SQL[] = [eq(strategies.chainId, chainId)];
  if (filter.safe) conditions.push(eq(strategies.safe, filter.safe));
  if (filter.mm) conditions.push(eq(strategies.mm, filter.mm));
  if (filter.policy) conditions.push(eq(strategies.policyId, filter.policy));
  return db.select().from(strategies).where(and(...conditions)).orderBy(asc(strategies.createdBlock)).limit(500);
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

export async function getPolicy(db: Db, chainId: number, policyId: string) {
  const [row] = await db
    .select()
    .from(policies)
    .where(and(eq(policies.chainId, chainId), eq(policies.policyId, policyId)));
  return row;
}

export async function getStrategy(db: Db, chainId: number, strategyId: string) {
  const [row] = await db
    .select()
    .from(strategies)
    .where(and(eq(strategies.chainId, chainId), eq(strategies.strategyId, strategyId)));
  return row;
}

export async function latestPolicySnapshot(db: Db, chainId: number, policyId: string) {
  const [row] = await db
    .select()
    .from(policySnapshots)
    .where(and(eq(policySnapshots.chainId, chainId), eq(policySnapshots.policyId, policyId)))
    .orderBy(desc(policySnapshots.blockNumber))
    .limit(1);
  return row;
}

export async function latestStrategySnapshot(db: Db, chainId: number, strategyId: string) {
  const [row] = await db
    .select()
    .from(strategySnapshots)
    .where(and(eq(strategySnapshots.chainId, chainId), eq(strategySnapshots.strategyId, strategyId)))
    .orderBy(desc(strategySnapshots.blockNumber))
    .limit(1);
  return row;
}

type Range = { fromBlock?: bigint | undefined; toBlock?: bigint | undefined; limit: number };

/** Policy readings over time (counters and risk), oldest first. */
export async function policySeries(db: Db, chainId: number, policyId: string, range: Range) {
  const conditions: SQL[] = [eq(policySnapshots.chainId, chainId), eq(policySnapshots.policyId, policyId)];
  if (range.fromBlock !== undefined) conditions.push(gte(policySnapshots.blockNumber, range.fromBlock));
  if (range.toBlock !== undefined) conditions.push(lte(policySnapshots.blockNumber, range.toBlock));
  return db.select().from(policySnapshots).where(and(...conditions)).orderBy(asc(policySnapshots.blockNumber)).limit(range.limit);
}

/** Strategy readings over time (spread, inventory, fees), oldest first. */
export async function strategySeries(db: Db, chainId: number, strategyId: string, range: Range) {
  const conditions: SQL[] = [eq(strategySnapshots.chainId, chainId), eq(strategySnapshots.strategyId, strategyId)];
  if (range.fromBlock !== undefined) conditions.push(gte(strategySnapshots.blockNumber, range.fromBlock));
  if (range.toBlock !== undefined) conditions.push(lte(strategySnapshots.blockNumber, range.toBlock));
  return db.select().from(strategySnapshots).where(and(...conditions)).orderBy(asc(strategySnapshots.blockNumber)).limit(range.limit);
}

/** Sort position of simulated attempts within their block: after every onchain log. */
export const SIMULATED_ORD = 2_000_000_000;

export type ActivityRow = {
  kind: "fill" | "attempt";
  strategy_id: string;
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
  risk_mode: number | null;
  quality_bps: number | null;
  error_name: string | null;
  error_args: unknown;
  explanation: string | null;
  request: unknown;
};

/**
 * Fills and attempts for one strategy, or for every strategy of a policy, newest first, keyset-paginated on
 * (block, position, key).
 * Allowed onchain attempts duplicate their own fill, so only blocked onchain attempts are listed; simulated
 * attempts are listed with either outcome.
 */
export async function activity(
  db: Db,
  chainId: number,
  subject: Subject,
  page: { limit: number; before: ActivityCursor | null },
): Promise<ActivityRow[]> {
  const fillScope = subject.kind === "policy" ? sql`policy_id = ${subject.id}` : sql`strategy_id = ${subject.id}`;
  const attemptScope =
    subject.kind === "policy"
      ? sql`strategy_id IN (SELECT strategy_id FROM strategies WHERE chain_id = ${chainId} AND policy_id = ${subject.id})`
      : sql`strategy_id = ${subject.id}`;
  const before = page.before
    ? sql`WHERE (block_number, ord, key) < (${page.before.blockNumber}, ${page.before.ord}, ${page.before.key})`
    : sql``;
  const result = await db.execute<ActivityRow>(sql`
    SELECT * FROM (
      SELECT 'fill' AS kind, strategy_id, block_number, log_index AS ord, tx_hash || ':' || log_index AS key, timestamp,
             tx_hash, 'onchain' AS source, 'filled' AS outcome, is_sell, amount_in, amount_out, price_x36,
             fee_token, fee_amount, risk_mode::int AS risk_mode, quality_bps, NULL AS error_name,
             NULL::jsonb AS error_args, NULL AS explanation, NULL::jsonb AS request
        FROM fills WHERE chain_id = ${chainId} AND ${fillScope}
      UNION ALL
      SELECT 'attempt', strategy_id, block_number,
             CASE WHEN source = 'simulated' THEN ${SIMULATED_ORD} ELSE log_index END,
             CASE WHEN source = 'simulated'
                  -- creation time (µs, zero-padded) orders simulations within their block; id breaks ties
                  THEN lpad((extract(epoch FROM created_at) * 1000000)::bigint::text, 20, '0') || ':' || id::text
                  ELSE tx_hash || ':' || log_index END,
             timestamp, tx_hash, source::text, outcome::text, NULL, amount_in, amount_out, NULL, NULL, NULL,
             NULL, NULL, error_name, error_args, explanation, request
        FROM attempts
       WHERE chain_id = ${chainId} AND ${attemptScope}
         AND (source = 'simulated' OR outcome = 'blocked')
    ) AS feed
    ${before}
    ORDER BY block_number DESC, ord DESC, key DESC
    LIMIT ${page.limit}
  `);
  return [...result] as ActivityRow[];
}

/**
 * An issuer Safe's treasury: each policy with its latest reading (shared counters, release, risk mode) and the
 * figures of its strategies. Amounts are raw token units.
 */
export async function safeSummary(db: Db, chainId: number, safe: string) {
  const rows = await db.execute<PolicySummaryRow>(sql`
    SELECT p.policy_id, p.status, p.base, p.quote, p.config,
           s.gross_sold::text, s.net_sold::text, s.quote_spent::text, s.total_net_sold::text, s.released::text,
           s.period_ends_at::text, s.risk_mode::int, s.risk_reason::int, s.priced, s.spot_x36::text, s.twap_x36::text,
           s.trusted_depth_base::text
    FROM policies p
    LEFT JOIN LATERAL (
      SELECT * FROM policy_snapshots s WHERE s.chain_id = p.chain_id AND s.policy_id = p.policy_id
      ORDER BY s.block_number DESC LIMIT 1
    ) s ON true
    WHERE p.chain_id = ${chainId} AND p.safe = ${safe}
    ORDER BY p.created_block DESC`);
  const strategyRows = await strategySummary(db, chainId, { safe });
  return rows.map((p) => ({
    ...presentPolicy(p),
    strategies: strategyRows.filter((s) => s.policyId === p.policy_id),
  }));
}

/** A market maker's strategies across every issuer, each with its treasury's risk mode. */
export async function mmSummary(db: Db, chainId: number, mm: string) {
  return strategySummary(db, chainId, { mm });
}

type PolicySummaryRow = {
  policy_id: string; status: number; base: string; quote: string; config: unknown;
  gross_sold: string | null; net_sold: string | null; quote_spent: string | null; total_net_sold: string | null;
  released: string | null; period_ends_at: string | null; risk_mode: number | null; risk_reason: number | null;
  priced: boolean | null; spot_x36: string | null; twap_x36: string | null; trusted_depth_base: string | null;
};

function presentPolicy(r: PolicySummaryRow) {
  return {
    policyId: r.policy_id,
    status: r.status,
    base: r.base,
    quote: r.quote,
    config: r.config,
    grossSold: r.gross_sold ?? "0",
    netSold: r.net_sold ?? "0",
    quoteSpent: r.quote_spent ?? "0",
    totalNetSold: r.total_net_sold ?? "0",
    released: r.released ?? "0",
    periodEndsAt: r.period_ends_at,
    riskMode: r.risk_mode,
    riskReason: r.risk_reason,
    priced: r.priced,
    spotX36: r.spot_x36,
    twapX36: r.twap_x36,
    trustedDepthBase: r.trusted_depth_base,
  };
}

/**
 * Per-strategy figures from indexed rows only: the latest strategy reading (spread, fees and the market maker's share
 * of them), fill count, quote volume and average execution quality, refused attempts, and its policy's risk mode.
 */
async function strategySummary(db: Db, chainId: number, filter: { safe: string } | { mm: string }) {
  const party = "safe" in filter ? sql`st.safe = ${filter.safe}` : sql`st.mm = ${filter.mm}`;
  const rows = await db.execute<{
    strategy_id: string; policy_id: string; safe: string; status: number; kind: number; mm: string; base: string;
    quote: string; mm_fee_share_bps: string; spread_bps: number | null; shipped_base: string | null;
    shipped_quote: string | null; fees_base: string | null; fees_quote: string | null; claimed_base: string | null;
    claimed_quote: string | null; fills: number; quote_volume: string; avg_quality_bps: string | null; refused: number;
    policy_status: number | null; risk_mode: number | null; risk_reason: number | null;
  }>(sql`
    SELECT st.strategy_id, st.policy_id, st.safe, st.status, st.kind, st.mm, st.base, st.quote,
           st.bounds->>'mmFeeShareBps' AS mm_fee_share_bps,
           s.spread_bps, s.shipped_base::text, s.shipped_quote::text, s.fees_base::text, s.fees_quote::text,
           s.claimed_base::text, s.claimed_quote::text,
           coalesce(f.fills, 0)::int AS fills, coalesce(f.quote_volume, 0)::text AS quote_volume,
           f.avg_quality_bps::text, coalesce(a.refused, 0)::int AS refused,
           p.status::int AS policy_status, ps.risk_mode::int, ps.risk_reason::int
    FROM strategies st
    LEFT JOIN policies p ON p.chain_id = st.chain_id AND p.policy_id = st.policy_id
    LEFT JOIN LATERAL (
      SELECT * FROM strategy_snapshots s WHERE s.chain_id = st.chain_id AND s.strategy_id = st.strategy_id
      ORDER BY s.block_number DESC LIMIT 1
    ) s ON true
    LEFT JOIN LATERAL (
      SELECT risk_mode, risk_reason FROM policy_snapshots ps WHERE ps.chain_id = st.chain_id AND ps.policy_id = st.policy_id
      ORDER BY ps.block_number DESC LIMIT 1
    ) ps ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS fills, sum(CASE WHEN f.is_sell THEN f.amount_in ELSE f.amount_out END) AS quote_volume,
             -- Quote-volume-weighted, over fills that had a reference price.
             round(sum(f.quality_bps * (CASE WHEN f.is_sell THEN f.amount_in ELSE f.amount_out END))
               / nullif(sum(CASE WHEN f.quality_bps IS NULL THEN 0 ELSE (CASE WHEN f.is_sell THEN f.amount_in ELSE f.amount_out END) END), 0), 2)
               AS avg_quality_bps
      FROM fills f WHERE f.chain_id = st.chain_id AND f.strategy_id = st.strategy_id
    ) f ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS refused FROM attempts a
      WHERE a.chain_id = st.chain_id AND a.strategy_id = st.strategy_id AND a.outcome = 'blocked'
    ) a ON true
    WHERE st.chain_id = ${chainId} AND ${party}
    ORDER BY st.created_block DESC`);
  // Snapshot fees are the total spread fees; the market maker earns its fixed share (MandateModule._claimable).
  const share = (fees: string | null, bps: string) => ((BigInt(fees ?? "0") * BigInt(bps)) / 10_000n).toString();
  return rows.map((r) => ({
    strategyId: r.strategy_id,
    policyId: r.policy_id,
    safe: r.safe,
    status: r.status,
    kind: r.kind,
    mm: r.mm,
    base: r.base,
    quote: r.quote,
    spreadBps: r.spread_bps,
    shippedBase: r.shipped_base ?? "0",
    shippedQuote: r.shipped_quote ?? "0",
    feesBase: r.fees_base ?? "0",
    feesQuote: r.fees_quote ?? "0",
    claimedBase: r.claimed_base ?? "0",
    claimedQuote: r.claimed_quote ?? "0",
    mmFeeShareBps: Number(r.mm_fee_share_bps),
    mmEarnedBase: share(r.fees_base, r.mm_fee_share_bps),
    mmEarnedQuote: share(r.fees_quote, r.mm_fee_share_bps),
    fills: r.fills,
    quoteVolume: r.quote_volume,
    avgQualityBps: r.avg_quality_bps === null ? null : Number(r.avg_quality_bps),
    refused: r.refused,
    policyStatus: r.policy_status,
    riskMode: r.risk_mode,
    riskReason: r.risk_reason,
  }));
}

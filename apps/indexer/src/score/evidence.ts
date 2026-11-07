import { sql } from "drizzle-orm";

import type { Db } from "../db/client.ts";
import { WINDOW_SECONDS, type MmEvidence } from "./score.ts";

/**
 * Gathers score evidence for every market maker with a strategy on `chainId`, over the window ending at `now`
 * (chain time of the indexed head). Everything comes from indexed rows: strategies, fills with their execution
 * quality (price against the Uniswap spot before the fill) and their policy's quote tolerance, module events, and
 * probes.
 */
export async function loadEvidence(db: Db, chainId: number, now: bigint): Promise<MmEvidence[]> {
  const from = now - BigInt(WINDOW_SECONDS);

  // Strategies per MM: count, revoked, and days managed (creation → revocation or now).
  const tenure = await db.execute<{ mm: string; strategies: number; revoked: number; managed_seconds: string }>(sql`
    SELECT m.mm,
           count(*)::int AS strategies,
           count(*) FILTER (WHERE m.status = 3)::int AS revoked,
           coalesce(sum(greatest(0, coalesce(rb.timestamp, ${now}) - cb.timestamp)), 0)::text AS managed_seconds
    FROM strategies m
    JOIN blocks cb ON cb.chain_id = m.chain_id AND cb.number = m.created_block
    LEFT JOIN LATERAL (
      SELECT b.timestamp FROM raw_events e JOIN blocks b ON b.chain_id = e.chain_id AND b.number = e.block_number
      WHERE e.chain_id = m.chain_id AND e.strategy_id = m.strategy_id AND e.event_name = 'StrategyRevoked'
      ORDER BY e.block_number LIMIT 1
    ) rb ON true
    WHERE m.chain_id = ${chainId}
    GROUP BY m.mm`);

  // Fills in the window: quote-side volume (whole tokens) and execution quality: the fill price's distance from the
  // Uniswap spot before the fill, as a share of the issuer's quote tolerance (policy config).
  const fills = await db.execute<{ mm: string; fills: number; volume: string; weighted: string }>(sql`
    WITH f AS (
      SELECT m.mm,
             (CASE WHEN f.is_sell THEN f.amount_in ELSE f.amount_out END) / power(10::numeric, coalesce(t.decimals, 18)) AS volume,
             CASE WHEN f.quality_bps IS NOT NULL AND (p.config->'price'->>'maxQuoteDeviationBps')::numeric > 0
                  THEN least(1, abs(f.quality_bps) / (p.config->'price'->>'maxQuoteDeviationBps')::numeric)
                  ELSE NULL END AS deviation
      FROM fills f
      JOIN strategies m ON m.chain_id = f.chain_id AND m.strategy_id = f.strategy_id
      JOIN policies p ON p.chain_id = f.chain_id AND p.policy_id = f.policy_id
      LEFT JOIN tokens t ON t.chain_id = m.chain_id AND t.address = m.quote
      WHERE f.chain_id = ${chainId} AND f.timestamp >= ${from}
    )
    SELECT mm, count(*)::int AS fills, coalesce(sum(volume), 0)::text AS volume,
           -- Fills without a reference price count as at the edge of the tolerance.
           coalesce(sum(volume * coalesce(deviation, 1)), 0)::text AS weighted
    FROM f GROUP BY mm`);

  // Probe rounds: one per strategy and probe time; ok if every side filled, fault if any side failed for the MM's reason.
  const rounds = await db.execute<{ mm: string; strategy_id: string; timestamp: string; ok: boolean; fault: boolean }>(sql`
    SELECT mm, strategy_id, timestamp::text,
           bool_and(outcome = 'ok') AS ok, bool_or(outcome = 'mm_fault') AS fault
    FROM mm_probes
    WHERE chain_id = ${chainId} AND timestamp >= ${from}
    GROUP BY mm, strategy_id, timestamp
    ORDER BY strategy_id, timestamp`);

  // Issuer bounds changes (not the one emitted at creation) and the MM's next reship after each.
  const reships = await db.execute<{ mm: string; delay_seconds: string }>(sql`
    SELECT m.mm,
           (coalesce((
             SELECT min(sb.timestamp) FROM raw_events s JOIN blocks sb ON sb.chain_id = s.chain_id AND sb.number = s.block_number
             WHERE s.chain_id = e.chain_id AND s.strategy_id = e.strategy_id AND s.event_name = 'StrategyShipped'
               AND (s.block_number, s.log_index) > (e.block_number, e.log_index)
           ), ${now}) - b.timestamp)::text AS delay_seconds
    FROM raw_events e
    JOIN blocks b ON b.chain_id = e.chain_id AND b.number = e.block_number
    JOIN strategies m ON m.chain_id = e.chain_id AND m.strategy_id = e.strategy_id
    WHERE e.chain_id = ${chainId} AND e.event_name = 'StrategyBoundsUpdated' AND b.timestamp >= ${from}
      AND NOT EXISTS (SELECT 1 FROM raw_events c WHERE c.chain_id = e.chain_id AND c.tx_hash = e.tx_hash AND c.event_name = 'StrategyAdded')`);

  const byMm = new Map<string, { okRounds: number; faultRounds: number; responseMinutes: number[] }>();
  const entry = (mm: string) => {
    let e = byMm.get(mm);
    if (!e) byMm.set(mm, (e = { okRounds: 0, faultRounds: 0, responseMinutes: [] }));
    return e;
  };
  // Walk each strategy's rounds in time order: a fault opens an incident, the next ok round closes it.
  let openSince: { strategyId: string; at: number } | undefined;
  let previous: { mm: string; strategyId: string } | undefined;
  const closeOpen = (mm: string, at: number) => {
    if (openSince) entry(mm).responseMinutes.push((at - openSince.at) / 60);
    openSince = undefined;
  };
  for (const r of rounds) {
    if (previous && previous.strategyId !== r.strategy_id) closeOpen(previous.mm, Number(now));
    const at = Number(r.timestamp);
    if (r.ok) {
      entry(r.mm).okRounds++;
      closeOpen(r.mm, at);
    } else if (r.fault) {
      entry(r.mm).faultRounds++;
      openSince ??= { strategyId: r.strategy_id, at };
    }
    previous = { mm: r.mm, strategyId: r.strategy_id };
  }
  if (previous) closeOpen(previous.mm, Number(now));
  for (const r of reships) entry(r.mm).responseMinutes.push(Number(r.delay_seconds) / 60);

  const fillsByMm = new Map(fills.map((f) => [f.mm, f]));
  return tenure.map((t) => {
    const f = fillsByMm.get(t.mm);
    const p = byMm.get(t.mm);
    return {
      mm: t.mm,
      okRounds: p?.okRounds ?? 0,
      faultRounds: p?.faultRounds ?? 0,
      responseMinutes: p?.responseMinutes ?? [],
      fills: f?.fills ?? 0,
      quoteVolume: Number(f?.volume ?? 0),
      weightedDeviation: Number(f?.weighted ?? 0),
      strategies: t.strategies,
      revoked: t.revoked,
      managedDays: Number(t.managed_seconds) / 86_400,
    };
  });
}

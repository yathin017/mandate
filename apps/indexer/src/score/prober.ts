import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Address, Hash } from "viem";

import type { ChainContext } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { blocks, mandates, mmProbes, rawEvents, syncCursors } from "../db/schema.ts";

/**
 * Availability probes for the market-maker score. Every `INDEXER_PROBE_INTERVAL_S` it quotes each live mandate at
 * the indexed head, once per side, with a trade of 0.1% of the shipped inventory, and records whether it would fill.
 * Quotes are `eth_call`s through the SwapVM router: nothing is sent and nothing costs gas.
 *
 * Only refusals the market maker controls count against it (see `classify`); issuer rails, the anchor's own breakers
 * and RPC failures are recorded as neutral.
 */
/** Quote caller. Any address works for a view quote; a fixed one keeps probes recognisable. */
export const PROBE_TAKER = "0x000000000000000000000000000000000000dEaD" as Address;
/** Probe size as a fraction of the shipped base inventory. */
const PROBE_DIVISOR = 1000n;
const RETENTION_SECONDS = 35n * 86_400n;

/** Refusals the market maker could have prevented by reshipping (price or inventory) in time. */
const MM_FAULTS = new Set(["AnchorDeviation", "InsufficientLiquidity", "ZeroBalance"]);

export function classify(errorName: string | null): "ok" | "mm_fault" | "neutral" {
  if (errorName === null) return "ok";
  return MM_FAULTS.has(errorName) ? "mm_fault" : "neutral";
}

export class Prober {
  private readonly ctx: ChainContext;
  private readonly db: Db;
  private readonly config: Config;
  private readonly log: (message: string) => void;

  constructor(ctx: ChainContext, db: Db, config: Config, log: (message: string) => void = (m) => console.log(`[prober] ${m}`)) {
    this.ctx = ctx;
    this.db = db;
    this.config = config;
    this.log = log;
  }

  async run(signal: AbortSignal): Promise<void> {
    const interval = this.config.INDEXER_PROBE_INTERVAL_S * 1000;
    if (interval === 0) return;
    while (!signal.aborted) {
      try {
        const count = await this.probeOnce();
        if (count > 0) this.log(`recorded ${count} probes`);
      } catch (error) {
        this.log(`probe round failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, interval);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
      });
    }
  }

  /** One round at the indexed head. Returns the number of probes written. */
  async probeOnce(): Promise<number> {
    const chainId = this.ctx.chainId;
    const [cursor] = await this.db.select().from(syncCursors).where(eq(syncCursors.chainId, chainId)).limit(1);
    if (!cursor) return 0;
    const [block] = await this.db
      .select({ timestamp: blocks.timestamp })
      .from(blocks)
      .where(and(eq(blocks.chainId, chainId), eq(blocks.number, cursor.blockNumber)))
      .limit(1);
    if (!block) return 0;

    const live = await this.db
      .select({ mandateId: mandates.mandateId, mm: mandates.mm, base: mandates.base, quote: mandates.quote, status: mandates.status, params: mandates.params })
      .from(mandates)
      .where(and(eq(mandates.chainId, chainId), inArray(mandates.status, [1, 2])));

    const rows: (typeof mmProbes.$inferInsert)[] = [];
    for (const m of live) {
      const base = { chainId, mandateId: m.mandateId, mm: m.mm, blockNumber: cursor.blockNumber, timestamp: block.timestamp };
      if (m.status === 2) {
        // Pausing is the market maker's fault only when the market maker paused it.
        const pausedBy = await this.lastPauser(m.mandateId);
        const outcome = pausedBy === m.mm ? "mm_fault" : "neutral";
        for (const side of ["sell", "buy"] as const) rows.push({ ...base, side, outcome, errorName: "MandatePaused" });
        continue;
      }
      const amount = BigInt((m.params as { shippedBase: string }).shippedBase) / PROBE_DIVISOR;
      if (amount === 0n) continue;
      for (const side of ["sell", "buy"] as const) {
        // sell: a taker buys `amount` base from the treasury (exact out); buy: a taker sells `amount` base to it.
        const result = await this.ctx.sdk.quote(m.mandateId as Hash, {
          taker: PROBE_TAKER,
          tokenIn: (side === "sell" ? m.quote : m.base) as Address,
          tokenOut: (side === "sell" ? m.base : m.quote) as Address,
          amount,
          isExactIn: side === "buy",
          blockNumber: cursor.blockNumber,
        });
        const errorName = result.ok ? null : result.error.errorName;
        rows.push({ ...base, side, outcome: classify(errorName), errorName });
      }
    }
    if (rows.length > 0) await this.db.insert(mmProbes).values(rows).onConflictDoNothing();
    await this.db.delete(mmProbes).where(and(eq(mmProbes.chainId, chainId), lt(mmProbes.timestamp, block.timestamp - RETENTION_SECONDS)));
    return rows.length;
  }

  private async lastPauser(mandateId: string): Promise<string | undefined> {
    const [event] = await this.db
      .select({ args: rawEvents.args })
      .from(rawEvents)
      .where(and(eq(rawEvents.chainId, this.ctx.chainId), eq(rawEvents.mandateId, mandateId), eq(rawEvents.eventName, "MandatePaused")))
      .orderBy(desc(rawEvents.blockNumber), desc(rawEvents.logIndex))
      .limit(1);
    return (event?.args as { by?: string } | undefined)?.by?.toLowerCase();
  }
}

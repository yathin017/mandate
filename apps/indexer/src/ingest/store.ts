import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Hash } from "viem";

import type { Db } from "../db/client.ts";
import {
  attempts,
  blocks,
  chains,
  fills,
  launchedTokens,
  policies,
  policySnapshots,
  rawEvents,
  strategies,
  strategySnapshots,
  syncCursors,
  tokens,
} from "../db/schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type BlockRow = typeof blocks.$inferInsert;
export type RawEventRow = typeof rawEvents.$inferInsert;
export type FillRow = typeof fills.$inferInsert;
export type AttemptRow = typeof attempts.$inferInsert;
export type PolicySnapshotRow = typeof policySnapshots.$inferInsert;
export type StrategySnapshotRow = typeof strategySnapshots.$inferInsert;
export type PolicyRow = typeof policies.$inferInsert;
export type StrategyRow = typeof strategies.$inferInsert;
export type TokenRow = typeof tokens.$inferInsert;
export type LaunchedTokenRow = typeof launchedTokens.$inferInsert;

export interface Batch {
  readonly blocks: BlockRow[];
  readonly events: RawEventRow[];
  readonly fills: FillRow[];
  readonly attempts: AttemptRow[];
  readonly policySnapshots: PolicySnapshotRow[];
  readonly strategySnapshots: StrategySnapshotRow[];
  readonly policies: PolicyRow[];
  readonly strategies: StrategyRow[];
  readonly tokens: TokenRow[];
  readonly launchedTokens: LaunchedTokenRow[];
  readonly cursor: { readonly number: bigint; readonly hash: Hash };
}

/** All writes for one indexed range, atomically. Re-running a range is a no-op (idempotent inserts). */
export async function writeBatch(db: Db, chainId: number, batch: Batch): Promise<void> {
  await db.transaction(async (tx) => {
    if (batch.blocks.length) await tx.insert(blocks).values(batch.blocks).onConflictDoNothing();
    if (batch.events.length) await tx.insert(rawEvents).values(batch.events).onConflictDoNothing();
    if (batch.fills.length) await tx.insert(fills).values(batch.fills).onConflictDoNothing();
    if (batch.attempts.length) await tx.insert(attempts).values(batch.attempts).onConflictDoNothing();
    if (batch.policySnapshots.length) await tx.insert(policySnapshots).values(batch.policySnapshots).onConflictDoNothing();
    if (batch.strategySnapshots.length) await tx.insert(strategySnapshots).values(batch.strategySnapshots).onConflictDoNothing();
    if (batch.tokens.length) await tx.insert(tokens).values(batch.tokens).onConflictDoNothing();
    if (batch.launchedTokens.length) await tx.insert(launchedTokens).values(batch.launchedTokens).onConflictDoNothing();
    // Policies first: strategies reference them.
    for (const row of batch.policies) await upsertPolicy(tx, row);
    for (const row of batch.strategies) await upsertStrategy(tx, row);
    await setCursor(tx, chainId, batch.cursor);
  });
}

async function upsertPolicy(tx: Tx, row: PolicyRow) {
  await tx
    .insert(policies)
    .values(row)
    .onConflictDoUpdate({
      target: [policies.chainId, policies.policyId],
      // created_block is kept from the first sighting; everything else follows the chain.
      set: { status: row.status, config: row.config, updatedBlock: row.updatedBlock },
      setWhere: sql`${policies.updatedBlock} <= ${row.updatedBlock}`,
    });
}

async function upsertStrategy(tx: Tx, row: StrategyRow) {
  await tx
    .insert(strategies)
    .values(row)
    .onConflictDoUpdate({
      target: [strategies.chainId, strategies.strategyId],
      // The policy, market maker, pair and kind never change onchain; status and terms follow the chain.
      set: {
        status: row.status,
        activeStrategyHash: row.activeStrategyHash,
        bounds: row.bounds,
        params: row.params,
        updatedBlock: row.updatedBlock,
      },
      setWhere: sql`${strategies.updatedBlock} <= ${row.updatedBlock}`,
    });
}

async function setCursor(tx: Tx | Db, chainId: number, cursor: { number: bigint; hash: Hash }) {
  await tx
    .insert(syncCursors)
    .values({ chainId, blockNumber: cursor.number, blockHash: cursor.hash })
    .onConflictDoUpdate({
      target: syncCursors.chainId,
      set: { blockNumber: cursor.number, blockHash: cursor.hash, updatedAt: sql`now()` },
    });
}

export async function ensureChain(
  db: Db,
  chain: { chainId: number; name: string; environment: string; sourceChainId: number },
  start: BlockRow,
): Promise<{ number: bigint; hash: Hash }> {
  return db.transaction(async (tx) => {
    await tx.insert(chains).values(chain).onConflictDoNothing();
    const [cursor] = await tx.select().from(syncCursors).where(eq(syncCursors.chainId, chain.chainId));
    if (cursor) return { number: cursor.blockNumber, hash: cursor.blockHash as Hash };
    await tx.insert(blocks).values(start).onConflictDoNothing();
    await setCursor(tx, chain.chainId, { number: start.number, hash: start.hash as Hash });
    return { number: start.number, hash: start.hash as Hash };
  });
}

/** Stored blocks, newest first, for finding the common ancestor after a reorg. */
export async function storedBlocksDesc(db: Db, chainId: number, limit = 1024) {
  return db
    .select({ number: blocks.number, hash: blocks.hash })
    .from(blocks)
    .where(eq(blocks.chainId, chainId))
    .orderBy(desc(blocks.number))
    .limit(limit);
}

/** Deletes everything after `ancestor`. FK cascades remove dependent events, fills, attempts, snapshots and policies/strategies created after it. */
export async function rollbackTo(db: Db, chainId: number, ancestor: { number: bigint; hash: Hash }): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(blocks)
      .where(and(eq(blocks.chainId, chainId), gt(blocks.number, ancestor.number)))
      .returning({ number: blocks.number });
    // Rows created before the ancestor survive but may carry terms read after it; lowering their version lets the
    // re-index overwrite them with the canonical chain's state.
    await tx
      .update(policies)
      .set({ updatedBlock: ancestor.number })
      .where(and(eq(policies.chainId, chainId), gt(policies.updatedBlock, ancestor.number)));
    await tx
      .update(strategies)
      .set({ updatedBlock: ancestor.number })
      .where(and(eq(strategies.chainId, chainId), gt(strategies.updatedBlock, ancestor.number)));
    await setCursor(tx, chainId, ancestor);
    return removed.length;
  });
}

/** Every indexed policy and strategy of a chain; each is re-read at the end of every range. */
export async function knownIds(db: Db, chainId: number): Promise<{ policies: Hash[]; strategies: Hash[] }> {
  const [p, st] = await Promise.all([
    db.select({ id: policies.policyId }).from(policies).where(eq(policies.chainId, chainId)),
    db.select({ id: strategies.strategyId }).from(strategies).where(eq(strategies.chainId, chainId)),
  ]);
  return { policies: p.map((row) => row.id as Hash), strategies: st.map((row) => row.id as Hash) };
}

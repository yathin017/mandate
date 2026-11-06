import { and, desc, eq, gt, sql } from "drizzle-orm";
import type { Hash } from "viem";

import type { Db } from "../db/client.ts";
import { attempts, blocks, chains, fills, mandates, rawEvents, snapshots, syncCursors } from "../db/schema.ts";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export type BlockRow = typeof blocks.$inferInsert;
export type RawEventRow = typeof rawEvents.$inferInsert;
export type FillRow = typeof fills.$inferInsert;
export type AttemptRow = typeof attempts.$inferInsert;
export type SnapshotRow = typeof snapshots.$inferInsert;
export type MandateRow = typeof mandates.$inferInsert;

export interface Batch {
  readonly blocks: BlockRow[];
  readonly events: RawEventRow[];
  readonly fills: FillRow[];
  readonly attempts: AttemptRow[];
  readonly snapshots: SnapshotRow[];
  readonly mandates: MandateRow[];
  readonly cursor: { readonly number: bigint; readonly hash: Hash };
}

/** All writes for one indexed range, atomically. Re-running a range is a no-op (idempotent inserts). */
export async function writeBatch(db: Db, chainId: number, batch: Batch): Promise<void> {
  await db.transaction(async (tx) => {
    if (batch.blocks.length) await tx.insert(blocks).values(batch.blocks).onConflictDoNothing();
    if (batch.events.length) await tx.insert(rawEvents).values(batch.events).onConflictDoNothing();
    if (batch.fills.length) await tx.insert(fills).values(batch.fills).onConflictDoNothing();
    if (batch.attempts.length) await tx.insert(attempts).values(batch.attempts).onConflictDoNothing();
    if (batch.snapshots.length) await tx.insert(snapshots).values(batch.snapshots).onConflictDoNothing();
    for (const row of batch.mandates) await upsertMandate(tx, row);
    await setCursor(tx, chainId, batch.cursor);
  });
}

async function upsertMandate(tx: Tx, row: MandateRow) {
  await tx
    .insert(mandates)
    .values(row)
    .onConflictDoUpdate({
      target: [mandates.chainId, mandates.mandateId],
      // created_block is kept from the first sighting; everything else follows the chain.
      set: {
        status: row.status,
        mm: row.mm,
        activeStrategyHash: row.activeStrategyHash,
        bounds: row.bounds,
        params: row.params,
        updatedBlock: row.updatedBlock,
      },
      setWhere: sql`${mandates.updatedBlock} <= ${row.updatedBlock}`,
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

/** Deletes everything after `ancestor`. FK cascades remove dependent events, fills, attempts and snapshots. */
export async function rollbackTo(db: Db, chainId: number, ancestor: { number: bigint; hash: Hash }): Promise<number> {
  return db.transaction(async (tx) => {
    const removed = await tx
      .delete(blocks)
      .where(and(eq(blocks.chainId, chainId), gt(blocks.number, ancestor.number)))
      .returning({ number: blocks.number });
    await setCursor(tx, chainId, ancestor);
    return removed.length;
  });
}

export async function knownMandateIds(db: Db, chainId: number): Promise<Hash[]> {
  const rows = await db.select({ id: mandates.mandateId }).from(mandates).where(eq(mandates.chainId, chainId));
  return rows.map((row) => row.id as Hash);
}

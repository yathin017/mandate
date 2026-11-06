import { explainError, type MandateSnapshot } from "@mandate/sdk";
import { encodePacked, keccak256, type Hash, type Hex } from "viem";

import type { ChainContext } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { lower, toJsonSafe } from "../json.ts";
import { decodeLogs, mandateIdOf, type DecodedEvent } from "./events.ts";
import {
  ensureChain,
  knownMandateIds,
  rollbackTo,
  storedBlocksDesc,
  writeBatch,
  type AttemptRow,
  type BlockRow,
  type FillRow,
  type MandateRow,
  type RawEventRow,
  type SnapshotRow,
  type TokenRow,
} from "./store.ts";

/** Emitted after a batch commits; the cache layer invalidates and notifies subscribers from it. */
export interface BatchCommitted {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly toHash: Hash;
  readonly mandateIds: readonly Hash[];
  readonly reorg: boolean;
}

export class ReorgDuringRead extends Error {}

/**
 * Pulls Mandate logs in block ranges, derives fills/attempts/snapshots and commits each range atomically.
 * Reorgs are detected by comparing the stored cursor hash with the canonical chain; the worker then rolls back
 * to the newest stored block that is still canonical (FK cascades drop everything after it) and re-indexes.
 */
export class Indexer {
  private cursor: { number: bigint; hash: Hash } | undefined;
  private readonly ctx: ChainContext;
  private readonly db: Db;
  private readonly config: Config;
  private readonly onCommitted: (event: BatchCommitted) => Promise<void> | void;
  private readonly log: (message: string) => void;

  constructor(
    ctx: ChainContext,
    db: Db,
    config: Config,
    onCommitted: (event: BatchCommitted) => Promise<void> | void = () => {},
    log: (message: string) => void = (message) => console.log(`[indexer] ${message}`),
  ) {
    this.ctx = ctx;
    this.db = db;
    this.config = config;
    this.onCommitted = onCommitted;
    this.log = log;
  }

  async init(): Promise<void> {
    const start = await this.ctx.client.getBlock({ blockNumber: this.ctx.startBlock.number });
    if (this.ctx.startBlock.hash && lower(start.hash) !== lower(this.ctx.startBlock.hash)) {
      throw new Error(
        `RPC block ${start.number} is ${start.hash}, deployment expects ${this.ctx.startBlock.hash}: wrong chain or fork`,
      );
    }
    const { deployment } = this.ctx;
    this.cursor = await ensureChain(
      this.db,
      {
        chainId: this.ctx.chainId,
        name: `chain ${this.ctx.chainId}`,
        environment: deployment.environment,
        sourceChainId: deployment.sourceChainId,
      },
      blockRow(this.ctx.chainId, start),
    );
    this.log(`cursor at block ${this.cursor.number}`);
  }

  /** Runs until `signal` aborts. Errors are logged and retried after the poll interval. */
  async run(signal: AbortSignal): Promise<void> {
    if (!this.cursor) await this.init();
    while (!signal.aborted) {
      let progressed = false;
      try {
        progressed = await this.step();
      } catch (error) {
        this.log(`step failed, retrying: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (!progressed) await sleep(this.config.INDEXER_POLL_INTERVAL_MS, signal);
    }
  }

  /** Indexes at most one range. Returns false when already at the confirmed head. */
  async step(): Promise<boolean> {
    const cursor = this.cursor;
    if (!cursor) throw new Error("Indexer not initialised");
    const { client } = this.ctx;

    // Canonicality first: a replacement chain can be shorter than the one we indexed, so this check must not
    // wait for the head to pass the cursor.
    const head = await client.getBlockNumber();
    const current = head >= cursor.number ? await client.getBlock({ blockNumber: cursor.number }) : undefined;
    if (!current || current.hash === null || lower(current.hash) !== lower(cursor.hash)) {
      await this.handleReorg();
      return true;
    }

    const target = head - BigInt(this.config.INDEXER_CONFIRMATIONS);
    if (target <= cursor.number) return false;

    const from = cursor.number + 1n;
    const to = minBigint(target, cursor.number + BigInt(this.config.INDEXER_LOG_RANGE));
    const batch = await this.readRange(from, to);
    await writeBatch(this.db, this.ctx.chainId, batch);
    this.cursor = batch.cursor;

    const touched = new Set<Hash>();
    for (const row of batch.snapshots) touched.add(row.mandateId as Hash);
    await this.onCommitted({
      chainId: this.ctx.chainId,
      fromBlock: from,
      toBlock: to,
      toHash: batch.cursor.hash,
      mandateIds: [...touched],
      reorg: false,
    });
    if (batch.events.length) this.log(`indexed ${from}..${to}: ${batch.events.length} events`);
    return true;
  }

  private async handleReorg(): Promise<void> {
    const stored = await storedBlocksDesc(this.db, this.ctx.chainId);
    const head = await this.ctx.client.getBlockNumber();
    for (const block of stored) {
      if (block.number > head) continue; // no longer exists at all
      const canonical = await this.ctx.client.getBlock({ blockNumber: block.number });
      if (canonical.hash !== null && lower(canonical.hash) === lower(block.hash)) {
        const removed = await rollbackTo(this.db, this.ctx.chainId, { number: block.number, hash: block.hash as Hash });
        this.cursor = { number: block.number, hash: block.hash as Hash };
        this.log(`reorg: rolled back ${removed} blocks to ${block.number}`);
        await this.onCommitted({
          chainId: this.ctx.chainId,
          fromBlock: block.number,
          toBlock: block.number,
          toHash: block.hash as Hash,
          mandateIds: await knownMandateIds(this.db, this.ctx.chainId),
          reorg: true,
        });
        return;
      }
    }
    throw new Error("Reorg deeper than stored history; re-create the database for this chain");
  }

  private async readRange(from: bigint, to: bigint) {
    const { client, deployment, chainId } = this.ctx;
    const toHeader = await client.getBlock({ blockNumber: to });
    const logs = await client.getLogs({
      address: [deployment.module, deployment.quoter, ...(this.ctx.actor ? [this.ctx.actor] : [])],
      fromBlock: from,
      toBlock: to,
    });
    const events = decodeLogs(logs, { module: deployment.module, quoter: deployment.quoter, actor: this.ctx.actor });

    // Headers for every block with events, each checked against the logs' block hash.
    const headers = new Map<bigint, Awaited<ReturnType<typeof client.getBlock>>>([[to, toHeader]]);
    for (const number of new Set(events.map((e) => e.blockNumber))) {
      if (!headers.has(number)) headers.set(number, await client.getBlock({ blockNumber: number }));
    }
    for (const event of events) {
      const header = headers.get(event.blockNumber)!;
      if (header.hash === null || lower(header.hash) !== lower(event.blockHash)) {
        throw new ReorgDuringRead(`block ${event.blockNumber} changed while reading logs`);
      }
    }

    // Which mandates to snapshot at which blocks: every block that touched them, plus all known mandates at `to`.
    const reads = new Map<string, { id: Hash; block: bigint }>();
    const want = (id: Hash, block: bigint) => reads.set(`${id}:${block}`, { id, block });
    for (const event of events) {
      const id = mandateIdOf(event) ?? this.attemptMandate(event);
      if (id) want(id as Hash, event.blockNumber);
    }
    for (const id of await knownMandateIds(this.db, chainId)) want(id, to);
    for (const read of [...reads.values()]) if (read.block !== to) want(read.id, to);

    const snapshotsByKey = new Map<string, MandateSnapshot>();
    await forEachLimited([...reads.values()], this.config.INDEXER_SNAPSHOT_CONCURRENCY, async ({ id, block }) => {
      snapshotsByKey.set(`${id}:${block}`, await this.ctx.sdk.readSnapshot(id, block));
    });

    const fillRows: FillRow[] = [];
    const attemptRows: AttemptRow[] = [];
    const pendingFees = new Map<string, { token: string; amount: bigint }>();
    for (const event of events) {
      const ts = headers.get(event.blockNumber)!.timestamp;
      if (event.eventName === "FeeAccrued") {
        pendingFees.set(`${event.txHash}:${mandateIdOf(event)}`, {
          token: lower(String(event.args.token)),
          amount: event.args.amount as bigint,
        });
      } else if (event.eventName === "Filled") {
        fillRows.push(this.fillRow(event, ts, pendingFees));
      } else if (event.eventName === "Attempted") {
        const row = await this.attemptRow(event, ts, snapshotsByKey);
        if (row) attemptRows.push(row);
      }
    }

    const snapshotRows: SnapshotRow[] = [];
    const mandateRows = new Map<string, MandateRow>();
    for (const { id, block } of reads.values()) {
      const snapshot = snapshotsByKey.get(`${id}:${block}`)!;
      snapshotRows.push(snapshotRow(chainId, id, snapshot));
      const previous = mandateRows.get(id);
      if (!previous || previous.updatedBlock < block) mandateRows.set(id, this.mandateRow(id, snapshot));
    }

    const tokenRows = new Map<string, TokenRow>();
    for (const row of mandateRows.values()) {
      for (const address of [row.base, row.quote]) {
        if (tokenRows.has(address)) continue;
        const display = await this.ctx.tokenDisplay(address as Hex);
        tokenRows.set(address, { chainId, address, symbol: display.symbol, decimals: display.decimals });
      }
    }

    // The range end must still be canonical after all reads.
    const toAgain = await client.getBlock({ blockNumber: to });
    if (lower(toAgain.hash) !== lower(toHeader.hash)) throw new ReorgDuringRead(`block ${to} changed during the batch`);

    return {
      blocks: [...headers.values()].map((header) => blockRow(chainId, header)),
      events: events.map((event) => rawEventRow(chainId, event)),
      fills: fillRows,
      attempts: attemptRows,
      snapshots: snapshotRows,
      mandates: [...mandateRows.values()],
      tokens: [...tokenRows.values()],
      cursor: { number: to, hash: lower(toHeader.hash!) as Hash },
    };
  }

  /** Demo actor attempts map to a mandate through their act number; non-mandate targets are skipped. */
  private attemptMandate(event: DecodedEvent): Hash | null {
    if (event.eventName !== "Attempted") return null;
    if (this.ctx.nonMandateTargets.has(lower(String(event.args.target)))) return null;
    const id = this.ctx.actMandates.get(event.args.act as bigint);
    return id ? (lower(id) as Hash) : null;
  }

  private fillRow(event: DecodedEvent, timestamp: bigint, fees: Map<string, { token: string; amount: bigint }>): FillRow {
    const a = event.args;
    const mandateId = mandateIdOf(event)!;
    const fee = fees.get(`${event.txHash}:${mandateId}`);
    fees.delete(`${event.txHash}:${mandateId}`);
    return {
      chainId: this.ctx.chainId,
      txHash: lower(event.txHash),
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      timestamp,
      mandateId,
      strategyHash: lower(String(a.strategyHash)),
      taker: lower(String(a.taker)),
      isSell: Boolean(a.isSell),
      amountIn: String(a.amountIn),
      amountOut: String(a.amountOut),
      priceX36: String(a.priceX36),
      netSoldThisEpoch: String(a.netSoldThisEpoch),
      totalNetSold: String(a.totalNetSold),
      feeToken: fee?.token ?? null,
      feeAmount: (fee?.amount ?? 0n).toString(),
    };
  }

  private async attemptRow(
    event: DecodedEvent,
    timestamp: bigint,
    snapshots: Map<string, MandateSnapshot>,
  ): Promise<AttemptRow | null> {
    const mandateId = this.attemptMandate(event);
    if (!mandateId) return null;
    const a = event.args;
    const target = lower(String(a.target));
    const success = Boolean(a.success);
    const snapshot = snapshots.get(`${mandateId}:${event.blockNumber}`);
    let explained = null;
    if (!success && snapshot) {
      const [base, quote] = await Promise.all([
        this.ctx.tokenDisplay(snapshot.mandate.base),
        this.ctx.tokenDisplay(snapshot.mandate.quote),
      ]);
      explained = explainError(a.result as Hex, { base, quote, now: timestamp, epochResetsAt: snapshot.epochResetsAt });
    } else if (!success) {
      explained = explainError(a.result as Hex);
    }
    return {
      chainId: this.ctx.chainId,
      mandateId,
      source: "onchain_actor",
      outcome: success ? "allowed" : "blocked",
      errorName: explained?.errorName ?? null,
      errorArgs: explained ? toJsonSafe(explained.args) : null,
      revertData: success ? null : lower(String(a.result)),
      explanation: explained?.message ?? null,
      request: { target, act: String(a.act), step: String(a.step), targetKind: this.targetKind(target, snapshot) },
      requestHash: keccak256(encodePacked(["bytes32", "uint256"], [event.txHash, BigInt(event.logIndex)])),
      blockNumber: event.blockNumber,
      blockHash: lower(event.blockHash),
      timestamp,
      txHash: lower(event.txHash),
      logIndex: event.logIndex,
    };
  }

  private targetKind(target: string, snapshot: MandateSnapshot | undefined): string {
    const { deployment } = this.ctx;
    if (deployment.environment === "local-mainnet-fork" && target === lower(deployment.taker)) return "trade";
    if (target === lower(deployment.module)) return "module";
    if (snapshot && target === lower(snapshot.mandate.safe)) return "safe";
    return "other";
  }

  private mandateRow(id: Hash, s: MandateSnapshot): MandateRow {
    return {
      chainId: this.ctx.chainId,
      mandateId: lower(id),
      module: lower(this.ctx.deployment.module),
      safe: lower(s.mandate.safe),
      mm: lower(s.mandate.mm),
      base: lower(s.mandate.base),
      quote: lower(s.mandate.quote),
      status: Number(s.mandate.status),
      activeStrategyHash: lower(s.mandate.activeStrategyHash),
      bounds: toJsonSafe(s.mandate.bounds),
      params: toJsonSafe(s.mandate.params),
      createdBlock: s.source.blockNumber,
      updatedBlock: s.source.blockNumber,
    };
  }
}

function blockRow(chainId: number, header: { number: bigint | null; hash: Hash | null; parentHash: Hash; timestamp: bigint }): BlockRow {
  if (header.number === null || header.hash === null) throw new Error("Pending blocks are never indexed");
  return {
    chainId,
    number: header.number,
    hash: lower(header.hash),
    parentHash: lower(header.parentHash),
    timestamp: header.timestamp,
  };
}

function rawEventRow(chainId: number, event: DecodedEvent): RawEventRow {
  return {
    chainId,
    blockNumber: event.blockNumber,
    blockHash: lower(event.blockHash),
    txHash: lower(event.txHash),
    logIndex: event.logIndex,
    address: lower(event.address),
    eventName: event.eventName,
    mandateId: mandateIdOf(event),
    args: toJsonSafe(event.args),
  };
}

function snapshotRow(chainId: number, mandateId: Hash, s: MandateSnapshot): SnapshotRow {
  const anchor = s.anchor;
  const priced = anchor.status !== "unavailable";
  return {
    chainId,
    mandateId: lower(mandateId),
    blockNumber: s.source.blockNumber,
    blockHash: lower(s.source.blockHash),
    timestamp: s.source.timestamp,
    status: Number(s.mandate.status),
    spreadBps: Number(s.mandate.params.spreadBps),
    epochCap: s.mandate.params.epochCap.toString(),
    epochIndex: s.epoch.index.toString(),
    netSoldThisEpoch: s.epoch.netSold.toString(),
    totalNetSold: s.epoch.totalNetSold.toString(),
    released: s.released.toString(),
    remainingThisEpoch: s.remainingThisEpoch.toString(),
    sellableNow: s.sellableNow.toString(),
    epochResetsAt: s.epochResetsAt.toString(),
    feesBase: s.feesAccrued[0].toString(),
    feesQuote: s.feesAccrued[1].toString(),
    claimedBase: s.claimed[0].toString(),
    claimedQuote: s.claimed[1].toString(),
    anchorStatus: anchor.status,
    anchorSpotX36: priced ? anchor.spotPriceX36.toString() : null,
    anchorTwapX36: priced ? anchor.twapPriceX36.toString() : null,
    anchorDeviationBps: priced ? anchor.deviationBps.toString() : null,
    anchorMaxDeviationBps: priced ? Number(anchor.maxDeviationBps) : null,
  };
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]!);
  });
  await Promise.all(workers);
}

function minBigint(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

import { explainError, uniswapV4MarketOracleAbi, type PolicySnapshot, type StrategySnapshot } from "@mandate/sdk";
import { encodePacked, keccak256, type Address, type Hash, type Hex } from "viem";

import type { ChainContext } from "../chain.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { lower, toJsonSafe } from "../json.ts";
import { decodeLogs, policyIdOf, strategyIdOf, type DecodedEvent } from "./events.ts";
import {
  ensureChain,
  knownIds,
  rollbackTo,
  storedBlocksDesc,
  writeBatch,
  type AttemptRow,
  type BlockRow,
  type FillRow,
  type LaunchedTokenRow,
  type PolicyRow,
  type PolicySnapshotRow,
  type RawEventRow,
  type StrategyRow,
  type StrategySnapshotRow,
  type TokenRow,
} from "./store.ts";

/** Emitted after a batch commits; the cache layer invalidates and notifies subscribers from it. */
export interface BatchCommitted {
  readonly chainId: number;
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly toHash: Hash;
  readonly policyIds: readonly Hash[];
  readonly strategyIds: readonly Hash[];
  readonly reorg: boolean;
}

export class ReorgDuringRead extends Error {}

const BPS = 10_000n;
const INT32_MAX = 2_147_483_647n;

/**
 * Pulls Mandate logs in block ranges, derives fills/attempts/snapshots and commits each range atomically.
 * Reorgs are detected by comparing the stored cursor hash with the canonical chain; the worker then rolls back
 * to the newest stored block that is still canonical (FK cascades drop everything after it) and re-indexes.
 *
 * Every policy and strategy is snapshotted at each block that touched it and at the end of every range, so
 * dashboards always have a reading at the indexed head.
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

    await this.onCommitted({
      chainId: this.ctx.chainId,
      fromBlock: from,
      toBlock: to,
      toHash: batch.cursor.hash,
      policyIds: [...new Set(batch.policySnapshots.map((row) => row.policyId as Hash))],
      strategyIds: [...new Set(batch.strategySnapshots.map((row) => row.strategyId as Hash))],
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
        const known = await knownIds(this.db, this.ctx.chainId);
        await this.onCommitted({
          chainId: this.ctx.chainId,
          fromBlock: block.number,
          toBlock: block.number,
          toHash: block.hash as Hash,
          policyIds: known.policies,
          strategyIds: known.strategies,
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
    const { actor, tokenFactory } = this.ctx;
    const logs = await client.getLogs({
      address: [deployment.module, deployment.quoter, ...(actor ? [actor] : []), ...(tokenFactory ? [tokenFactory] : [])],
      fromBlock: from,
      toBlock: to,
    });
    const events = decodeLogs(logs, { module: deployment.module, quoter: deployment.quoter, actor, tokenFactory });

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

    // Strategies to read at which blocks: every block that touched them, plus every known strategy at `to`.
    const known = await knownIds(this.db, chainId);
    const strategyReads = new Map<string, { id: Hash; block: bigint }>();
    const wantStrategy = (id: Hash, block: bigint) => strategyReads.set(`${id}:${block}`, { id, block });
    for (const event of events) {
      const id = strategyIdOf(event) ?? this.attemptStrategy(event);
      if (id) wantStrategy(id, event.blockNumber);
    }
    for (const id of known.strategies) wantStrategy(id, to);
    for (const read of [...strategyReads.values()]) if (read.block !== to) wantStrategy(read.id, to);

    const strategySnaps = new Map<string, StrategySnapshot>();
    await forEachLimited([...strategyReads.values()], this.config.INDEXER_SNAPSHOT_CONCURRENCY, async ({ id, block }) => {
      strategySnaps.set(`${id}:${block}`, await this.ctx.sdk.readStrategy(id, block));
    });

    // Policies: those named by events, those of every strategy read (same block), and every known policy at `to`.
    const policyReads = new Map<string, { id: Hash; block: bigint }>();
    const wantPolicy = (id: Hash, block: bigint) => policyReads.set(`${id}:${block}`, { id, block });
    for (const event of events) {
      const id = policyIdOf(event);
      if (id) wantPolicy(id, event.blockNumber);
    }
    for (const [key, snap] of strategySnaps) wantPolicy(lower(snap.strategy.policyId) as Hash, BigInt(key.split(":")[1]!));
    for (const id of known.policies) wantPolicy(id, to);
    for (const read of [...policyReads.values()]) if (read.block !== to) wantPolicy(read.id, to);

    const policySnaps = new Map<string, PolicySnapshot>();
    await forEachLimited([...policyReads.values()], this.config.INDEXER_SNAPSHOT_CONCURRENCY, async ({ id, block }) => {
      policySnaps.set(`${id}:${block}`, await this.ctx.sdk.readPolicy(id, block));
    });

    const launchedRows: LaunchedTokenRow[] = [];
    const fillRows: FillRow[] = [];
    const attemptRows: AttemptRow[] = [];
    const pendingFees = new Map<string, { token: string; amount: bigint }>();
    for (const event of events) {
      const ts = headers.get(event.blockNumber)!.timestamp;
      if (event.eventName === "FeeAccrued") {
        pendingFees.set(`${event.txHash}:${strategyIdOf(event)}`, {
          token: lower(String(event.args.token)),
          amount: event.args.amount as bigint,
        });
      } else if (event.eventName === "Filled") {
        const policy = policySnaps.get(`${policyIdOf(event)}:${event.blockNumber}`);
        fillRows.push(await this.fillRow(event, ts, pendingFees, policy));
      } else if (event.eventName === "TokenLaunched") {
        const a = event.args;
        launchedRows.push({
          chainId,
          token: lower(String(a.token)),
          factory: lower(event.address),
          creator: lower(String(a.creator)),
          recipient: lower(String(a.recipient)),
          name: String(a.name),
          symbol: String(a.symbol),
          supply: (a.supply as bigint).toString(),
          blockNumber: event.blockNumber,
          timestamp: ts,
          txHash: lower(event.txHash),
        });
      } else if (event.eventName === "Attempted") {
        const row = await this.attemptRow(event, ts, strategySnaps, policySnaps);
        if (row) attemptRows.push(row);
      }
    }

    const policySnapshotRows: PolicySnapshotRow[] = [];
    const policyRows = new Map<string, PolicyRow>();
    for (const { id, block } of policyReads.values()) {
      const snap = policySnaps.get(`${id}:${block}`)!;
      policySnapshotRows.push(policySnapshotRow(chainId, id, snap));
      const previous = policyRows.get(id);
      if (!previous || previous.updatedBlock < block) policyRows.set(id, this.policyRow(id, snap));
    }
    const strategySnapshotRows: StrategySnapshotRow[] = [];
    const strategyRows = new Map<string, StrategyRow>();
    for (const { id, block } of strategyReads.values()) {
      const snap = strategySnaps.get(`${id}:${block}`)!;
      strategySnapshotRows.push(strategySnapshotRow(chainId, id, snap));
      const previous = strategyRows.get(id);
      if (!previous || previous.updatedBlock < block) {
        const policy = policySnaps.get(`${lower(snap.strategy.policyId)}:${block}`)!;
        strategyRows.set(id, this.strategyRow(id, snap, policy));
      }
    }

    // Display metadata for every token a policy uses or the factory launched.
    const tokenRows = new Map<string, TokenRow>();
    const tokenAddresses = [...[...policyRows.values()].flatMap((row) => [row.base, row.quote]), ...launchedRows.map((r) => r.token)];
    for (const address of tokenAddresses) {
      if (tokenRows.has(address)) continue;
      const display = await this.ctx.tokenDisplay(address as Hex);
      tokenRows.set(address, { chainId, address, symbol: display.symbol, decimals: display.decimals });
    }

    // The range end must still be canonical after all reads.
    const toAgain = await client.getBlock({ blockNumber: to });
    if (lower(toAgain.hash) !== lower(toHeader.hash)) throw new ReorgDuringRead(`block ${to} changed during the batch`);

    return {
      blocks: [...headers.values()].map((header) => blockRow(chainId, header)),
      events: events.map((event) => rawEventRow(chainId, event)),
      fills: fillRows,
      attempts: attemptRows,
      policySnapshots: policySnapshotRows,
      strategySnapshots: strategySnapshotRows,
      policies: [...policyRows.values()],
      strategies: [...strategyRows.values()],
      tokens: [...tokenRows.values()],
      launchedTokens: launchedRows,
      cursor: { number: to, hash: lower(toHeader.hash!) as Hash },
    };
  }

  /** Demo actor attempts map to a strategy through their act number; non-strategy targets are skipped. */
  private attemptStrategy(event: DecodedEvent): Hash | null {
    if (event.eventName !== "Attempted") return null;
    if (this.ctx.nonStrategyTargets.has(lower(String(event.args.target)))) return null;
    const id = this.ctx.actStrategies.get(event.args.act as bigint);
    return id ? (lower(id) as Hash) : null;
  }

  private async fillRow(
    event: DecodedEvent,
    timestamp: bigint,
    fees: Map<string, { token: string; amount: bigint }>,
    policy: PolicySnapshot | undefined,
  ): Promise<FillRow> {
    const a = event.args;
    const strategyId = strategyIdOf(event)!;
    const fee = fees.get(`${event.txHash}:${strategyId}`);
    fees.delete(`${event.txHash}:${strategyId}`);
    const priceX36 = a.priceX36 as bigint;
    const isSell = Boolean(a.isSell);
    const reference = policy ? await this.referenceSpot(policy, event.blockNumber - 1n) : null;
    return {
      chainId: this.ctx.chainId,
      txHash: lower(event.txHash),
      logIndex: event.logIndex,
      blockNumber: event.blockNumber,
      timestamp,
      policyId: policyIdOf(event)!,
      strategyId,
      strategyHash: lower(String(a.strategyHash)),
      taker: lower(String(a.taker)),
      isSell,
      amountIn: String(a.amountIn),
      amountOut: String(a.amountOut),
      priceX36: priceX36.toString(),
      riskMode: Number(a.mode),
      feeToken: fee?.token ?? null,
      feeAmount: (fee?.amount ?? 0n).toString(),
      referenceSpotX36: reference?.toString() ?? null,
      qualityBps: reference ? qualityBps(priceX36, reference, isSell) : null,
    };
  }

  /**
   * The market a taker saw before the fill: the policy's oracle spot at the end of the previous block. Null when the
   * oracle had no price (no history yet) or could not be read.
   */
  private async referenceSpot(policy: PolicySnapshot, block: bigint): Promise<bigint | null> {
    const { oracle } = policy.policy.config;
    try {
      const health = await this.ctx.client.readContract({
        address: oracle.oracle as Address,
        abi: uniswapV4MarketOracleAbi,
        functionName: "health",
        args: [policy.policy.base, policy.policy.quote, oracle.twapWindow, oracle.shortWindow, oracle.depthBandBps],
        blockNumber: block,
      });
      return health.priced && health.spotX36 > 0n ? health.spotX36 : null;
    } catch {
      return null;
    }
  }

  private async attemptRow(
    event: DecodedEvent,
    timestamp: bigint,
    strategies: Map<string, StrategySnapshot>,
    policies: Map<string, PolicySnapshot>,
  ): Promise<AttemptRow | null> {
    const strategyId = this.attemptStrategy(event);
    if (!strategyId) return null;
    const a = event.args;
    const target = lower(String(a.target));
    const success = Boolean(a.success);
    const strategy = strategies.get(`${strategyId}:${event.blockNumber}`);
    const policy = strategy ? policies.get(`${lower(strategy.strategy.policyId)}:${event.blockNumber}`) : undefined;
    let explained = null;
    if (!success && policy) {
      const [base, quote] = await Promise.all([
        this.ctx.tokenDisplay(policy.policy.base),
        this.ctx.tokenDisplay(policy.policy.quote),
      ]);
      explained = explainError(a.result as Hex, { base, quote, now: timestamp, periodEndsAt: policy.counters.periodEndsAt });
    } else if (!success) {
      explained = explainError(a.result as Hex);
    }
    return {
      chainId: this.ctx.chainId,
      strategyId,
      source: "onchain_actor",
      outcome: success ? "allowed" : "blocked",
      errorName: explained?.errorName ?? null,
      errorArgs: explained ? toJsonSafe(explained.args) : null,
      revertData: success ? null : lower(String(a.result)),
      explanation: explained?.message ?? null,
      request: { target, act: String(a.act), step: String(a.step), targetKind: this.targetKind(target, policy) },
      requestHash: keccak256(encodePacked(["bytes32", "uint256"], [event.txHash, BigInt(event.logIndex)])),
      blockNumber: event.blockNumber,
      blockHash: lower(event.blockHash),
      timestamp,
      txHash: lower(event.txHash),
      logIndex: event.logIndex,
    };
  }

  private targetKind(target: string, policy: PolicySnapshot | undefined): string {
    const { deployment } = this.ctx;
    if (deployment.environment === "local-mainnet-fork" && target === lower(deployment.taker)) return "trade";
    if (target === lower(deployment.module)) return "module";
    if (policy && target === lower(policy.policy.safe)) return "safe";
    return "other";
  }

  private policyRow(id: Hash, s: PolicySnapshot): PolicyRow {
    return {
      chainId: this.ctx.chainId,
      policyId: lower(id),
      module: lower(this.ctx.deployment.module),
      safe: lower(s.policy.safe),
      base: lower(s.policy.base),
      quote: lower(s.policy.quote),
      status: Number(s.policy.status),
      config: toJsonSafe(s.policy.config),
      createdBlock: s.source.blockNumber,
      updatedBlock: s.source.blockNumber,
    };
  }

  private strategyRow(id: Hash, s: StrategySnapshot, policy: PolicySnapshot): StrategyRow {
    return {
      chainId: this.ctx.chainId,
      strategyId: lower(id),
      policyId: lower(s.strategy.policyId),
      safe: lower(policy.policy.safe),
      mm: lower(s.strategy.mm),
      base: lower(policy.policy.base),
      quote: lower(policy.policy.quote),
      kind: Number(s.strategy.kind),
      status: Number(s.strategy.status),
      activeStrategyHash: lower(s.strategy.activeStrategyHash),
      bounds: toJsonSafe(s.strategy.bounds),
      params: toJsonSafe(s.strategy.params),
      createdBlock: s.source.blockNumber,
      updatedBlock: s.source.blockNumber,
    };
  }
}

/**
 * Signed distance of a fill price from the reference market, in bps, positive when it favoured the treasury
 * (a sell above the market, a buy below it). Truncated toward zero and clamped to the column's range.
 */
export function qualityBps(priceX36: bigint, referenceX36: bigint, isSell: boolean): number {
  const favour = isSell ? priceX36 - referenceX36 : referenceX36 - priceX36;
  const bps = (favour * BPS) / referenceX36;
  return Number(bps > INT32_MAX ? INT32_MAX : bps < -INT32_MAX ? -INT32_MAX : bps);
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
    policyId: policyIdOf(event),
    strategyId: strategyIdOf(event),
    args: toJsonSafe(event.args),
  };
}

function policySnapshotRow(chainId: number, policyId: Hash, s: PolicySnapshot): PolicySnapshotRow {
  const { counters: c, risk } = s;
  return {
    chainId,
    policyId: lower(policyId),
    blockNumber: s.source.blockNumber,
    blockHash: lower(s.source.blockHash),
    timestamp: s.source.timestamp,
    status: Number(s.policy.status),
    periodIndex: c.periodIndex.toString(),
    grossSold: c.grossSold.toString(),
    netSold: c.netSold.toString(),
    quoteSpent: c.quoteSpent.toString(),
    totalNetSold: c.totalNetSold.toString(),
    released: c.released.toString(),
    periodEndsAt: c.periodEndsAt.toString(),
    riskMode: Number(risk.mode),
    riskReason: Number(risk.reasonIndex),
    priced: risk.health.priced,
    spotX36: risk.health.spotX36.toString(),
    twapX36: risk.health.twapX36.toString(),
    shortTwapX36: risk.health.shortTwapX36.toString(),
    trustedDepthBase: risk.health.trustedDepthBase.toString(),
    poolAge: BigInt(risk.health.poolAge),
  };
}

function strategySnapshotRow(chainId: number, strategyId: Hash, s: StrategySnapshot): StrategySnapshotRow {
  return {
    chainId,
    strategyId: lower(strategyId),
    blockNumber: s.source.blockNumber,
    blockHash: lower(s.source.blockHash),
    timestamp: s.source.timestamp,
    status: Number(s.strategy.status),
    spreadBps: Number(s.strategy.params.spreadBps),
    shippedBase: s.strategy.params.shippedBase.toString(),
    shippedQuote: s.strategy.params.shippedQuote.toString(),
    nonce: s.nonce.toString(),
    feesBase: s.feesAccrued[0].toString(),
    feesQuote: s.feesAccrued[1].toString(),
    claimedBase: s.claimed[0].toString(),
    claimedQuote: s.claimed[1].toString(),
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

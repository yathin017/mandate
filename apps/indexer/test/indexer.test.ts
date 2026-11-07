import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { and, count, eq, sql } from "drizzle-orm";

import { createChainContext, type ChainContext } from "../src/chain.ts";
import { createDb } from "../src/db/client.ts";
import { attempts, fills, policies, policySnapshots, strategies, strategySnapshots, syncCursors } from "../src/db/schema.ts";
import { Indexer, type BatchCommitted } from "../src/ingest/indexer.ts";
import { loadReplay, resetDatabase, rpc, skip, testConfig, testDatabaseUrl } from "./helpers.ts";
import { getLocalForkDeployment } from "@mandate/chains";

/** These suites run against the local demo fork; its manifest supplies the fork-only addresses. */
const fork = getLocalForkDeployment();

const NON_STRATEGY_KINDS = new Set(["approval", "traditional-sell", "market-move"]);
const TRADE_KINDS = new Set(["treasury-sell", "treasury-buyback"]);

describe("indexer against the live demo chain", { skip }, () => {
  const config = testConfig();
  const { db, close } = createDb(testDatabaseUrl!);
  let ctx: ChainContext;
  let indexer: Indexer;
  const committed: BatchCommitted[] = [];

  async function syncToHead() {
    while (await indexer.step()) {
      /* keep indexing */
    }
  }

  before(async () => {
    await resetDatabase(testDatabaseUrl!);
    ctx = await createChainContext(config);
    indexer = new Indexer(ctx, db, config, (event) => void committed.push(event), () => {});
    await indexer.init();
    await syncToHead();
  });

  after(async () => {
    await close();
  });

  test("cursor reaches the chain head", async () => {
    const head = await ctx.client.getBlockNumber();
    const [cursor] = await db.select().from(syncCursors).where(eq(syncCursors.chainId, 31337));
    assert.equal(cursor!.blockNumber, head);
  });

  test("one fill per executed treasury trade, matching the replay export", async () => {
    const replay = await loadReplay();
    for (const act of replay.acts) {
      const expected = act.steps.filter((s) => TRADE_KINDS.has(s.kind) && s.outcome === "executed").length;
      const [row] = await db
        .select({ n: count() })
        .from(fills)
        .where(eq(fills.strategyId, act.strategyId.toLowerCase()));
      assert.equal(row!.n, expected, `act ${act.act} fills`);
    }
  });

  test("fills carry their policy, risk mode and execution quality against the pre-fill market", async () => {
    const rows = await db.select().from(fills);
    assert.ok(rows.length > 0);
    for (const row of rows) {
      assert.match(row.policyId, /^0x[0-9a-f]{64}$/);
      assert.ok(row.riskMode === 0 || row.riskMode === 1, "fills only happen in Normal or Defensive mode");
      assert.ok(row.referenceSpotX36 !== null, `reference price for ${row.txHash}`);
      // The demo pool sits at its strategy's price, so every fill lands within a few percent of the market.
      assert.ok(Math.abs(row.qualityBps!) < 500, `quality ${row.qualityBps} bps`);
    }
  });

  test("one blocked attempt per blocked strategy step, with a decoded reason", async () => {
    const replay = await loadReplay();
    for (const act of replay.acts) {
      const expected = act.steps.filter((s) => !NON_STRATEGY_KINDS.has(s.kind) && s.outcome === "blocked").length;
      const rows = await db
        .select()
        .from(attempts)
        .where(and(eq(attempts.strategyId, act.strategyId.toLowerCase()), eq(attempts.outcome, "blocked")));
      assert.equal(rows.length, expected, `act ${act.act} blocked attempts`);
      for (const row of rows) {
        assert.equal(row.source, "onchain_actor");
        assert.ok(row.errorName && row.errorName !== "UnknownError", `decoded error for ${row.txHash}`);
        assert.ok(row.explanation, "plain-language explanation");
        assert.match(row.revertData!, /^0x[0-9a-f]{8,}$/);
      }
    }
  });

  test("traditional-loan and market-move steps never become strategy history", async () => {
    const [row] = await db
      .select({ n: count() })
      .from(attempts)
      .where(sql`${attempts.request}->>'target' = ${fork.swapRouter.toLowerCase()}`);
    assert.equal(row!.n, 0);
  });

  test("policies, strategies and their snapshots exist for all three acts", async () => {
    const policyRows = await db.select().from(policies);
    const strategyRows = await db.select().from(strategies);
    assert.equal(policyRows.length, 3);
    assert.equal(strategyRows.length, 3);
    const act3 = strategyRows.find((m) => m.strategyId === fork.strategies.act3.toLowerCase())!;
    assert.equal(act3.status, 3, "act 3 ends revoked");
    assert.equal(act3.policyId, fork.policies.act3.toLowerCase());
    assert.equal(policyRows.find((p) => p.policyId === act3.policyId)!.status, 3, "its policy too");
    const [policySnaps] = await db.select({ n: count() }).from(policySnapshots);
    const [strategySnaps] = await db.select({ n: count() }).from(strategySnapshots);
    assert.ok(policySnaps!.n > 0 && strategySnaps!.n > 0);
  });

  test("the pump is recorded as a Paused risk mode, then a calm market", async () => {
    const act2 = fork.policies.act2.toLowerCase();
    const rows = await db.select().from(policySnapshots).where(eq(policySnapshots.policyId, act2));
    assert.ok(rows.some((r) => r.riskMode === 2 && r.riskReason === 4), "MoveBeyondPause recorded");
    const latest = rows.reduce((a, b) => (a.blockNumber > b.blockNumber ? a : b));
    assert.equal(latest.riskMode, 0, "calm at the head");
    assert.equal(latest.priced, true);
  });

  test("re-indexing is idempotent", async () => {
    const before = await db.select({ n: count() }).from(fills);
    assert.equal(await indexer.step(), false, "already at head");
    const afterRows = await db.select({ n: count() }).from(fills);
    assert.deepEqual(afterRows, before);
  });

  test("a reorg rolls back orphaned blocks and re-indexes the canonical chain", async () => {
    const url = config.INDEXER_RPC_URL;
    // Outer snapshot restores the shared demo node afterwards; inner one is the reorg point.
    const pristine = await rpc<string>(url, "evm_snapshot");
    const snapshotId = await rpc<string>(url, "evm_snapshot");
    try {
      const forkPoint = await ctx.client.getBlockNumber();
      await rpc(url, "anvil_mine", ["0x3"]);
      await syncToHead();
      const orphan = await ctx.client.getBlock({ blockNumber: forkPoint + 1n });

      // Replace the three blocks with two different ones. The replay pins a fixed timestamp interval, so empty
      // blocks would be byte-identical; a transaction in the first replacement block changes its hash.
      await rpc(url, "evm_revert", [snapshotId]);
      await rpc(url, "eth_sendTransaction", [
        { from: fork.deployer, to: fork.deployer, value: "0x1" },
      ]);
      await rpc(url, "anvil_mine", ["0x1"]);
      committed.length = 0;
      await syncToHead();

      assert.ok(committed.some((event) => event.reorg), "reorg reported");
      const replacement = await ctx.client.getBlock({ blockNumber: forkPoint + 1n });
      assert.notEqual(replacement.hash, orphan.hash);
      const [cursor] = await db.select().from(syncCursors);
      assert.equal(cursor!.blockNumber, forkPoint + 2n);
      assert.equal(cursor!.blockHash, (await ctx.client.getBlock({ blockNumber: forkPoint + 2n })).hash);
    } finally {
      // Leave the shared demo node exactly as the replay produced it.
      await rpc(url, "evm_revert", [pristine]);
    }
  });
});

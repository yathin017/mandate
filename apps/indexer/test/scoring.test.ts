import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import postgres from "postgres";

import { createApp } from "../src/api/app.ts";
import { Cache } from "../src/cache/cache.ts";
import { keys } from "../src/cache/keys.ts";
import { Prober } from "../src/score/prober.ts";
import { indexDemoChain, rpc, skip, testConfig } from "./helpers.ts";

/**
 * Probes and scores over the indexed demo fork: the demo market maker has real fills, a revoked strategy and live
 * ones. Blocks are mined between probe rounds, so the fork is snapshotted and restored.
 */
describe("market-maker scoring on the demo chain", { skip }, () => {
  const config = testConfig();
  let indexed: Awaited<ReturnType<typeof indexDemoChain>>;
  let cache: Cache;
  let app: ReturnType<typeof createApp>;
  let snapshot: string;

  before(async () => {
    indexed = await indexDemoChain(config);
    cache = await Cache.connect(config.REDIS_URL);
    snapshot = await rpc<string>(config.INDEXER_RPC_URL, "evm_snapshot");
    const head = await indexed.ctx.client.getBlock();
    await cache.setHead(config.INDEXER_CHAIN_ID, { number: head.number.toString(), hash: head.hash });
    app = createApp({ db: indexed.db, cache, config, log: () => {} });
  });
  after(async () => {
    await rpc(config.INDEXER_RPC_URL, "evm_revert", [snapshot]);
    // The head set above names blocks the revert removed; later suites must not read it.
    await cache.delete(keys.head(config.INDEXER_CHAIN_ID));
    await cache.close();
    await indexed.close();
  });

  test("each round probes every live strategy on both sides, at an indexed block", async () => {
    const prober = new Prober(indexed.ctx, indexed.db, config, () => {});
    let written = 0;
    for (let round = 0; round < 6; round++) {
      // Ten minutes of chain time per round, as the worker would see it.
      // Explicit timestamp: evm_increaseTime does not move this Anvil's clock.
      const now = (await indexed.ctx.client.getBlock()).timestamp;
      await rpc(config.INDEXER_RPC_URL, "evm_mine", [`0x${(now + 600n).toString(16)}`]);
      while (await indexed.indexer.step()) {
        /* index the new block */
      }
      written += await prober.probeOnce();
    }
    // The same head probed twice writes nothing new.
    await prober.probeOnce();

    const sql = postgres(config.DATABASE_URL, { max: 1 });
    const [counted] = await sql`SELECT count(*)::int AS live FROM strategies WHERE chain_id = ${config.INDEXER_CHAIN_ID} AND status IN (1, 2)`;
    const live = counted!.live as number;
    const rows = await sql`SELECT side, outcome, error_name FROM mm_probes`;
    const orphans = await sql`SELECT count(*)::int AS n FROM mm_probes p LEFT JOIN blocks b ON b.chain_id = p.chain_id AND b.number = p.block_number WHERE b.number IS NULL`;
    await sql.end();
    assert.ok(live > 0);
    assert.equal(rows.length, written);
    assert.equal(written, live * 2 * 6);
    assert.equal(orphans[0]!.n, 0);
    for (const r of rows) assert.ok(r.outcome === "ok" || r.error_name, "refusals carry their reason");
  });

  test("scores are served per market maker with every component's evidence", async () => {
    const head = await indexed.ctx.client.getBlock();
    await cache.setHead(config.INDEXER_CHAIN_ID, { number: head.number.toString(), hash: head.hash });
    const response = await app.request(`/v1/chains/${config.INDEXER_CHAIN_ID}/mms/scores`);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { head: { hash: string }; data: { weights: Record<string, number>; scores: any[] } };
    assert.equal(body.head.hash, head.hash);
    assert.equal(body.data.weights.availability, 0.35);
    const demo = body.data.scores.find((s) => s.components.volume.value !== null);
    assert.ok(demo, "the demo market maker has fills");
    assert.equal(demo.status, "scored");
    assert.ok(demo.score >= 0 && demo.score <= 100);
    for (const component of Object.values(demo.components) as { evidence: string }[]) assert.ok(component.evidence.length > 0);
    assert.ok(demo.components.availability.value !== null, "six probe rounds are enough to rate availability");

    const one = await app.request(`/v1/chains/${config.INDEXER_CHAIN_ID}/mms/${demo.mm}/score`);
    assert.equal(((await one.json()) as { data: { score: number } }).data.score, demo.score);
    assert.equal((await app.request(`/v1/chains/${config.INDEXER_CHAIN_ID}/mms/0x000000000000000000000000000000000000beef/score`)).status, 404);
  });
});

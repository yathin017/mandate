import { Cache } from "./cache/cache.ts";
import { createChainContext } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { Indexer, type BatchCommitted } from "./ingest/indexer.ts";
import { checkPostgres, checkRedis, checkRpc, runWithPreflight } from "./preflight.ts";

/** Indexer process: check infrastructure, migrate, then follow the chain until SIGINT/SIGTERM. */
const config = loadConfig();
await runWithPreflight("indexer", async () => {
  await checkPostgres(config.DATABASE_URL);
  await checkRedis(config.REDIS_URL, (message) => console.warn(`[indexer] ${message}`));
  await checkRpc(config.INDEXER_RPC_URL, config.INDEXER_CHAIN_ID);
});
await runMigrations(config.DATABASE_URL);
const { db, close } = createDb(config.DATABASE_URL);
const cache = await Cache.connect(config.REDIS_URL);
const ctx = await createChainContext(config);

/**
 * Runs only after Postgres has committed. Moving the head changes every response-cache key, so readers can
 * never see a cached response from an older head; subscribers are then told which mandates changed.
 */
async function announce(batch: BatchCommitted): Promise<void> {
  await cache.setHead(batch.chainId, { number: batch.toBlock.toString(), hash: batch.toHash });
  for (const mandateId of batch.mandateIds) {
    await cache.publish({
      chainId: batch.chainId,
      mandateId,
      blockNumber: batch.toBlock.toString(),
      blockHash: batch.toHash,
      reorg: batch.reorg,
    });
  }
}

const indexer = new Indexer(ctx, db, config, announce);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

await indexer.run(controller.signal);
await cache.close();
await close();

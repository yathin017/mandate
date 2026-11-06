import { createChainContext } from "./chain.ts";
import { loadConfig } from "./config.ts";
import { createDb } from "./db/client.ts";
import { runMigrations } from "./db/migrate.ts";
import { Indexer } from "./ingest/indexer.ts";

/** Indexer process: migrate, then follow the chain until SIGINT/SIGTERM. */
const config = loadConfig();
await runMigrations(config.DATABASE_URL);
const { db, close } = createDb(config.DATABASE_URL);
const ctx = await createChainContext(config);
const indexer = new Indexer(ctx, db, config);

const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => controller.abort());

await indexer.run(controller.signal);
await close();

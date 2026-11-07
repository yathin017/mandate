import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema.ts";

/** Opens a pooled connection. Callers must `close()` on shutdown. */
export function createDb(url: string, options: { max?: number } = {}) {
  const sql = postgres(url, { max: options.max ?? 10, onnotice: () => {} });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, close: () => sql.end({ timeout: 5 }) };
}

export type Db = ReturnType<typeof createDb>["db"];

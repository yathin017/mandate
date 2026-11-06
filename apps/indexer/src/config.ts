import { z } from "zod";

/**
 * Process configuration, validated once at startup. Invalid or missing settings stop the process
 * instead of falling back to defaults that could index the wrong chain or expose the API.
 */
const origin = z.string().trim().min(1);

const schema = z.object({
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  REDIS_URL: z.url({ protocol: /^rediss?$/ }),
  INDEXER_RPC_URL: z.url({ protocol: /^https?$/ }),
  INDEXER_CHAIN_ID: z.coerce.number().int().positive(),
  INDEXER_CONFIRMATIONS: z.coerce.number().int().min(0).max(256).default(0),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
  /** Max blocks fetched per eth_getLogs request; public RPCs often cap the range. */
  INDEXER_LOG_RANGE: z.coerce.number().int().min(1).max(10_000).default(500),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  API_CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(origin)),
  API_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid indexer configuration: ${issues}`);
  }
  return parsed.data;
}

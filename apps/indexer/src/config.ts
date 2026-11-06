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
  /** Parallel snapshot reads. Public RPCs rate-limit bursts; use 1 for them. */
  INDEXER_SNAPSHOT_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(8),
  /**
   * Local forks only: a TokenFactory deployed for development, so its launches are indexed. Live chains read the
   * factory from their deployment manifest and ignore this.
   */
  INDEXER_TOKEN_FACTORY: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/)
    .optional(),
  /** Market-maker availability probes (read-only quotes per live mandate and side). 0 turns them off. */
  INDEXER_PROBE_INTERVAL_S: z.coerce.number().int().min(0).max(86_400).default(600),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  API_CORS_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((origin) => origin.trim()).filter(Boolean))
    .pipe(z.array(origin)),
  API_ATTEMPTS_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(20),
  /**
   * Web origins allowed to sign in (EIP-4361). The SIWE message's domain and URI must match one of them, and
   * every state-changing auth request must carry one as its Origin header. Empty disables sign-in.
   */
  API_AUTH_ORIGINS: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((o) => o.trim()).filter(Boolean))
    .pipe(z.array(z.url({ protocol: /^https?$/ }).transform((o) => new URL(o).origin))),
  /** Absolute session lifetime; sessions are not extended by use. */
  API_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(24 * 7),
  /** Secure (`__Host-` prefixed) session cookie. Turn off only for plain-http development hosts. */
  API_SESSION_COOKIE_SECURE: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  API_AUTH_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(10),
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

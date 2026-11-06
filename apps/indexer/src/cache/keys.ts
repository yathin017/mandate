/**
 * Every Redis key and channel the indexer uses. Redis holds no source-of-truth data: deleting all keys is
 * always safe and only costs recomputation.
 */
export const keys = {
  /** `{ number, hash }` of the latest committed block. Response-cache keys embed its hash. */
  head: (chainId: number) => `mandate:v1:head:${chainId}`,
  /** Cached API response for one route at one head. A new head means a new key: no stale reads. */
  response: (chainId: number, headHash: string, route: string) => `mandate:v1:api:${chainId}:${headHash}:${route}`,
  /** Server-side simulation result for one request at one block (dedupes repeated POST /attempts). */
  simulation: (chainId: number, blockHash: string, requestHash: string) =>
    `mandate:v1:sim:${chainId}:${blockHash}:${requestHash}`,
  /** Fixed-window request counter per client per minute. */
  rateLimit: (scope: string, client: string, window: number) => `mandate:v1:rl:${scope}:${client}:${window}`,
  /** Pub/sub channel announcing committed changes for one mandate. */
  mandateChannel: (chainId: number, mandateId: string) => `mandate:v1:events:${chainId}:${mandateId}`,
} as const;

export const TTL = {
  responseSeconds: 30,
  simulationSeconds: 60,
  rateLimitSeconds: 60,
} as const;

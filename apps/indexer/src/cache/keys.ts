/**
 * Every Redis key and channel the indexer uses. Redis holds no source-of-truth data: deleting all keys is
 * always safe and only costs recomputation.
 */
export const keys = {
  /** `{ number, hash }` of the latest committed block. Response-cache keys embed its hash. */
  head: (chainId: number) => `mandate:v1:head:${chainId}`,
  /** Cached API response for one route at one head. A new head means a new key: no stale reads. */
  response: (chainId: number, headHash: string, route: string) => `mandate:v1:api:${chainId}:${headHash}:${route}`,
  /** Fixed-window request counter per client per minute. */
  rateLimit: (scope: string, client: string, window: number) => `mandate:v1:rl:${scope}:${client}:${window}`,
  /** Per-mandate counter bumped on writes that do not move the head (simulated attempts); part of feed keys. */
  mandateVersion: (chainId: number, mandateId: string) => `mandate:v1:ver:${chainId}:${mandateId}`,
  /** Pub/sub channel announcing committed changes for one mandate. */
  mandateChannel: (chainId: number, mandateId: string) => `mandate:v1:events:${chainId}:${mandateId}`,
} as const;

export const TTL = {
  responseSeconds: 30,
  rateLimitSeconds: 60,
} as const;

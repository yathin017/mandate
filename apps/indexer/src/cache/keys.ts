/**
 * Every Redis key and channel the indexer uses. Redis holds no source-of-truth data: deleting all keys is
 * always safe and only costs recomputation.
 */
/** What a change feed is about: a treasury policy or one of its strategies. Ids are lowercase 0x-hex. */
export interface Subject {
  readonly kind: "policy" | "strategy";
  readonly id: string;
}

export const keys = {
  /** `{ number, hash }` of the latest committed block. Response-cache keys embed its hash. */
  head: (chainId: number) => `mandate:v1:head:${chainId}`,
  /** Cached API response for one route at one head. A new head means a new key: no stale reads. */
  response: (chainId: number, headHash: string, route: string) => `mandate:v1:api:${chainId}:${headHash}:${route}`,
  /** Fixed-window request counter per client per minute. */
  rateLimit: (scope: string, client: string, window: number) => `mandate:v1:rl:${scope}:${client}:${window}`,
  /** Per-subject counter bumped on writes that do not move the head (simulated attempts); part of feed keys. */
  subjectVersion: (chainId: number, subject: Subject) => `mandate:v2:ver:${chainId}:${subject.kind}:${subject.id}`,
  /** One-time sign-in nonce. Consumed with GETDEL, so a signed message can be used once. */
  authNonce: (nonce: string) => `mandate:v1:auth:nonce:${nonce}`,
  /** Cached session lookup by token hash; deleted on sign-out, so revocation is immediate. */
  session: (tokenHash: string) => `mandate:v1:auth:session:${tokenHash}`,
  /** A Safe's owner list as the chain reported it; owner-gated marketplace actions read it. */
  safeOwners: (chainId: number, safe: string) => `mandate:v1:safe-owners:${chainId}:${safe}`,
  /** Public market-maker list; deleted whenever a profile is written. */
  mmList: () => `mandate:v1:mms:list`,
  /** Pub/sub channel announcing committed changes for one policy or strategy. */
  subjectChannel: (chainId: number, subject: Subject) => `mandate:v2:events:${chainId}:${subject.kind}:${subject.id}`,
} as const;

export const TTL = {
  responseSeconds: 30,
  rateLimitSeconds: 60,
  /** A sign-in message must be signed and submitted within this window. */
  authNonceSeconds: 600,
  /** Upper bound on a cached session lookup (capped by the session's own expiry). */
  sessionSeconds: 60,
  /** A removed Safe owner keeps marketplace access for at most this long. */
  safeOwnersSeconds: 60,
  mmListSeconds: 30,
} as const;

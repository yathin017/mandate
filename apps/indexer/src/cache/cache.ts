import { Redis } from "ioredis";

import { keys, TTL } from "./keys.ts";

export interface Head {
  readonly number: string;
  readonly hash: string;
}

/** Change notification published after a committed batch. */
export interface MandateChange {
  readonly chainId: number;
  readonly mandateId: string;
  readonly blockNumber: string;
  readonly blockHash: string;
  readonly reorg: boolean;
}

/**
 * Thin, failure-tolerant Redis wrapper. Every read returns `undefined` and every write is skipped when Redis is
 * unavailable, so callers fall back to Postgres. Errors are counted, never thrown.
 */
export class Cache {
  private failures = 0;
  private readonly redis: Redis;
  private readonly subscriberUrl: string;
  private subscriber: Redis | undefined;
  private readonly listeners = new Map<string, Set<(change: MandateChange) => void>>();

  private constructor(redis: Redis, subscriberUrl: string) {
    this.redis = redis;
    this.subscriberUrl = subscriberUrl;
  }

  /** Connects and waits up to 2s for readiness. If Redis is down the cache starts degraded and keeps retrying. */
  static async connect(url: string): Promise<Cache> {
    const redis = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5000),
    });
    redis.on("error", () => {}); // surfaced through `healthy()`; never crash the process
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2000);
      redis.once("ready", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    return new Cache(redis, url);
  }

  get failureCount(): number {
    return this.failures;
  }

  async healthy(): Promise<boolean> {
    return (await this.attempt(() => this.redis.ping())) === "PONG";
  }

  async getHead(chainId: number): Promise<Head | undefined> {
    return this.getJson<Head>(keys.head(chainId));
  }

  async setHead(chainId: number, head: Head): Promise<void> {
    await this.attempt(() => this.redis.set(keys.head(chainId), JSON.stringify(head)));
  }

  async getJson<T>(key: string): Promise<T | undefined> {
    const raw = await this.attempt(() => this.redis.get(key));
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds: number = TTL.responseSeconds): Promise<void> {
    await this.attempt(() => this.redis.set(key, JSON.stringify(value), "EX", ttlSeconds));
  }

  /**
   * Increments a fixed-window counter and returns the new count, or `undefined` if Redis is down
   * (callers decide whether to fail open or closed).
   */
  async hit(key: string, ttlSeconds: number): Promise<number | undefined> {
    return this.attempt(async () => {
      const [[, count]] = (await this.redis.multi().incr(key).expire(key, ttlSeconds, "NX").exec()) as [
        [Error | null, number],
      ];
      return count;
    });
  }

  async getMandateVersion(chainId: number, mandateId: string): Promise<string> {
    return (await this.attempt(() => this.redis.get(keys.mandateVersion(chainId, mandateId)))) ?? "0";
  }

  async bumpMandateVersion(chainId: number, mandateId: string): Promise<void> {
    await this.attempt(() => this.redis.incr(keys.mandateVersion(chainId, mandateId)));
  }

  async publish(change: MandateChange): Promise<void> {
    await this.attempt(() =>
      this.redis.publish(keys.mandateChannel(change.chainId, change.mandateId), JSON.stringify(change)),
    );
  }

  /**
   * Subscribes to one mandate's changes and returns an unsubscribe function. All subscriptions share one
   * dedicated Redis connection; a channel is subscribed on its first listener and released after its last.
   * Throws if Redis cannot be reached within 2s, so callers can refuse the stream.
   */
  async subscribe(chainId: number, mandateId: string, onChange: (change: MandateChange) => void): Promise<() => void> {
    const channel = keys.mandateChannel(chainId, mandateId);
    const subscriber = this.ensureSubscriber();
    let listeners = this.listeners.get(channel);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(channel, listeners);
      const subscribed = subscriber.subscribe(channel).then(
        () => true,
        () => false,
      );
      const timeout = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000).unref());
      if (!(await Promise.race([subscribed, timeout]))) {
        this.listeners.delete(channel);
        this.failures++;
        throw new Error("Redis subscription unavailable");
      }
    }
    listeners.add(onChange);
    return () => {
      const current = this.listeners.get(channel);
      if (!current) return;
      current.delete(onChange);
      if (current.size === 0) {
        this.listeners.delete(channel);
        void subscriber.unsubscribe(channel).catch(() => {});
      }
    };
  }

  private ensureSubscriber(): Redis {
    if (this.subscriber) return this.subscriber;
    const subscriber = new Redis(this.subscriberUrl, { maxRetriesPerRequest: 1, connectTimeout: 2000 });
    subscriber.on("error", () => {});
    subscriber.on("message", (channel: string, message: string) => {
      const listeners = this.listeners.get(channel);
      if (!listeners) return;
      let change: MandateChange;
      try {
        change = JSON.parse(message) as MandateChange;
      } catch {
        return; // ignore malformed messages
      }
      for (const listener of listeners) listener(change);
    });
    this.subscriber = subscriber;
    return subscriber;
  }

  async close(): Promise<void> {
    this.subscriber?.disconnect();
    this.redis.disconnect();
  }

  private async attempt<T>(fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch {
      this.failures++;
      return undefined;
    }
  }
}

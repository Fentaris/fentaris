import type { Middleware } from "../types/middleware.js";
import type { ToolCallRequest } from "../types/mcp-operation.js";
import type { RateLimiter, RateLimitStore } from "../types/policy.js";
import type { UserContext } from "../types/shared.js";

type Bucket = {
  count: number;
  expiresAt: number;
};

/**
 * In-memory rate limit store with expiring buckets.
 * @pk
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly buckets = new Map<string, Bucket>();

  async increment(key: string, window: number): Promise<number> {
    const now = Date.now();
    const bucket = this.activeBucket(key, now);
    if (!bucket) {
      this.buckets.set(key, { count: 1, expiresAt: now + window });
      return 1;
    }

    bucket.count += 1;
    return bucket.count;
  }

  async consume(key: string, window: number, limit: number): Promise<boolean> {
    if (limit <= 0) {
      return false;
    }

    const now = Date.now();
    const bucket = this.activeBucket(key, now);
    if (!bucket) {
      this.buckets.set(key, { count: 1, expiresAt: now + window });
      return true;
    }

    if (bucket.count >= limit) {
      return false;
    }

    bucket.count += 1;
    return true;
  }

  async get(key: string): Promise<number> {
    return this.activeBucket(key, Date.now())?.count ?? 0;
  }

  async reset(key: string): Promise<void> {
    this.buckets.delete(key);
  }

  private activeBucket(key: string, now: number): Bucket | undefined {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      return undefined;
    }

    if (bucket.expiresAt <= now) {
      this.buckets.delete(key);
      return undefined;
    }

    return bucket;
  }
}

/**
 * Sliding-window rate limiter with optional daily quota.
 * @pk
 */
export class SlidingWindowRateLimiter implements RateLimiter {
  readonly metadata: RateLimiter["metadata"];
  private readonly store: RateLimitStore;
  private readonly keyPrefix: string;
  private readonly consumeLocks = new Map<string, Promise<void>>();

  /**
   * Create a sliding-window limiter.
   * @pk
   */
  constructor(options: {
    store?: RateLimitStore;
    maxPerWindow?: number;
    windowMs?: number;
    maxDailyCalls?: number;
    keyPrefix?: string;
  }) {
    this.store = options.store ?? new MemoryRateLimitStore();
    this.metadata = {
      maxPerWindow: options.maxPerWindow,
      windowMs: options.windowMs ?? 60_000,
      maxDailyCalls: options.maxDailyCalls,
    };
    this.keyPrefix = options.keyPrefix ?? "fentaris:rate-limit";
  }

  async checkLimit(key: string): Promise<boolean> {
    const [windowCount, dailyCount] = await Promise.all([
      this.store.get(this.windowKey(key)),
      this.store.get(this.dailyKey(key)),
    ]);

    if (this.metadata?.maxPerWindow !== undefined && windowCount >= this.metadata.maxPerWindow) {
      return false;
    }

    if (this.metadata?.maxDailyCalls !== undefined && dailyCount >= this.metadata.maxDailyCalls) {
      return false;
    }

    return true;
  }

  async consume(key: string): Promise<boolean> {
    const maxPerWindow = this.metadata?.maxPerWindow;
    const maxDailyCalls = this.metadata?.maxDailyCalls;

    if (maxPerWindow !== undefined && maxDailyCalls !== undefined) {
      return this.consumeCompositeLimit(key, maxPerWindow, maxDailyCalls);
    }

    if (maxPerWindow !== undefined) {
      return Promise.resolve(this.store.consume(this.windowKey(key), this.metadata?.windowMs ?? 60_000, maxPerWindow));
    }

    if (maxDailyCalls !== undefined) {
      return Promise.resolve(this.store.consume(this.dailyKey(key), this.dailyWindowMs(), maxDailyCalls));
    }

    await this.recordCall(key);
    return true;
  }

  async recordCall(key: string): Promise<void> {
    await Promise.all([
      this.store.increment(this.windowKey(key), this.metadata?.windowMs ?? 60_000),
      this.store.increment(this.dailyKey(key), this.dailyWindowMs()),
    ]);
  }

  async getRemainingCalls(key: string): Promise<number> {
    const [windowCount, dailyCount] = await Promise.all([
      this.store.get(this.windowKey(key)),
      this.store.get(this.dailyKey(key)),
    ]);
    const remaining: number[] = [];

    if (this.metadata?.maxPerWindow !== undefined) {
      remaining.push(Math.max(0, this.metadata.maxPerWindow - windowCount));
    }

    if (this.metadata?.maxDailyCalls !== undefined) {
      remaining.push(Math.max(0, this.metadata.maxDailyCalls - dailyCount));
    }

    return remaining.length === 0 ? Number.POSITIVE_INFINITY : Math.min(...remaining);
  }

  private windowKey(key: string): string {
    return `${this.keyPrefix}:window:${key}`;
  }

  private dailyKey(key: string): string {
    return `${this.keyPrefix}:daily:${this.dayId()}:${key}`;
  }

  private dayId(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private dailyWindowMs(): number {
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCHours(24, 0, 0, 0);
    return Math.max(1, tomorrow.getTime() - now.getTime());
  }

  private async consumeCompositeLimit(key: string, maxPerWindow: number, maxDailyCalls: number): Promise<boolean> {
    return this.withConsumeLock(key, async () => {
      if (!(await this.checkLimit(key))) {
        return false;
      }

      const windowAccepted = await Promise.resolve(this.store.consume(this.windowKey(key), this.metadata?.windowMs ?? 60_000, maxPerWindow));
      if (!windowAccepted) {
        return false;
      }

      return Promise.resolve(this.store.consume(this.dailyKey(key), this.dailyWindowMs(), maxDailyCalls));
    });
  }

  private async withConsumeLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.consumeLocks.get(key) ?? Promise.resolve();
    let releaseLock: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const queued = previous.then(() => next, () => next);
    this.consumeLocks.set(key, queued);

    await previous.catch(() => undefined);

    try {
      return await task();
    } finally {
      releaseLock?.();
      if (this.consumeLocks.get(key) === queued) {
        this.consumeLocks.delete(key);
      }
    }
  }
}

/**
 * Build a stable rate-limit key for a user/server/tool tuple.
 * @pk
 */
export function rateLimitKey(request: ToolCallRequest, user: UserContext): string {
  return `${user.id ?? "anonymous"}:${request.serverName}:${request.toolName}`;
}

/**
 * Middleware helper that enforces a rate limiter before forwarding tool calls.
 * @pk
 */
export function rateLimitMiddleware(options: {
  limiter?: RateLimiter;
  key?: (request: ToolCallRequest, user: UserContext) => string;
  message?: string;
} = {}): Middleware {
  return async (request, context, next) => {
    const limiter = options.limiter ?? context.rateLimiter ?? context.policyDecision?.metadata?.limiter;
    if (!isRateLimiter(limiter)) {
      return next();
    }

    const key = options.key?.(request, context.user) ?? rateLimitKey(request, context.user);
    if (!(await consumeRateLimit(limiter, key))) {
      return context.res.deny(options.message ?? "Rate limit exceeded");
    }

    return next();
  };
}

type RateLimiterLike = {
  consume?: RateLimiter["consume"];
  checkLimit: RateLimiter["checkLimit"];
  recordCall: RateLimiter["recordCall"];
  getRemainingCalls: RateLimiter["getRemainingCalls"];
  metadata?: RateLimiter["metadata"];
};

async function consumeRateLimit(limiter: RateLimiterLike, key: string): Promise<boolean> {
  if (typeof limiter.consume === "function") {
    return Promise.resolve(limiter.consume(key));
  }

  if (!(await Promise.resolve(limiter.checkLimit(key)))) {
    return false;
  }

  await Promise.resolve(limiter.recordCall(key));
  return true;
}

function isRateLimiter(value: unknown): value is RateLimiterLike {
  return (
    value !== null &&
    typeof value === "object" &&
    hasFunction(value, "checkLimit") &&
    hasFunction(value, "recordCall") &&
    hasFunction(value, "getRemainingCalls") &&
    (!("consume" in value) || hasFunction(value, "consume"))
  );
}

function hasFunction(value: object, key: string): boolean {
  return key in value && typeof (value as Record<string, unknown>)[key] === "function";
}

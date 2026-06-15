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
    if (!(await limiter.checkLimit(key))) {
      return context.res.deny(options.message ?? "Rate limit exceeded");
    }

    await limiter.recordCall(key);
    return next();
  };
}

function isRateLimiter(value: unknown): value is RateLimiter {
  return (
    value !== null &&
    typeof value === "object" &&
    "checkLimit" in value &&
    "recordCall" in value &&
    "getRemainingCalls" in value
  );
}

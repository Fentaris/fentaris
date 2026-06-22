import { describe, expect, it, vi } from "vitest";
import {
  DefaultErrorMapper,
  MemoryRateLimitStore,
  FentarisErrorCode,
  ResponseController,
  SimplePolicy,
  SlidingWindowRateLimiter,
  filterToolsByPolicy,
  headerIdentityStrategy,
  rateLimitMiddleware,
  toCapabilityPermissions,
} from "../../src/index.js";
import type { MiddlewareContext } from "../../src/types.js";

describe("governance primitives", () => {
  it("evaluates policy decisions and filters listed tools", async () => {
    const policy = new SimplePolicy({
      name: "test",
      permissions: {
        github: [
          { tool: "allowed", metadata: { scope: "issues" } },
          { tool: "denied", effect: "deny" },
        ],
      },
    });

    await expect(
      policy.evaluate(
        { serverName: "github", toolName: "allowed", proxyToolName: "github__allowed", arguments: {}, raw: { name: "github__allowed" } },
        { id: "user-1" },
      ),
    ).resolves.toMatchObject({
      allowed: true,
      metadata: {
        policyName: "test",
        permission: { scope: "issues" },
      },
    });

    const filtered = filterToolsByPolicy([{ name: "allowed" }, { name: "denied" }], "github", policy);
    expect(filtered).toEqual([{ name: "allowed" }]);
  });

  it("adapts tool permissions to operation-based capability permissions", async () => {
    const policy = new SimplePolicy({
      name: "test",
      permissions: {
        github: [
          { tool: "allowed", metadata: { scope: "issues" } },
          { tool: "denied", effect: "deny" },
        ],
      },
    });

    expect(toCapabilityPermissions("github", policy.getPermissions("github"))).toMatchObject([
      { server: "github", operation: "tool:call", target: "allowed", targetKind: "tool" },
      { server: "github", operation: "tool:call", target: "denied", targetKind: "tool", effect: "deny" },
    ]);

    await expect(
      policy.evaluate(
        { serverName: "github", operation: "tool:call", target: "allowed", targetKind: "tool" },
        { id: "user-1" },
      ),
    ).resolves.toMatchObject({
      allowed: true,
      metadata: {
        operation: "tool:call",
        target: "allowed",
        toolName: "allowed",
      },
    });
  });

  it("enforces rate limits through middleware", async () => {
    const limiter = new SlidingWindowRateLimiter({
      store: new MemoryRateLimitStore(),
      maxPerWindow: 1,
      windowMs: 60_000,
    });
    const middleware = rateLimitMiddleware({ limiter });
    const request = {
      serverName: "github",
      toolName: "create_issue",
      proxyToolName: "github__create_issue",
      arguments: {},
      raw: { name: "github__create_issue" },
    };
    const context = {
      user: { id: "user-1" },
      log: { info: vi.fn() },
      res: new ResponseController(),
    } as unknown as MiddlewareContext;

    await expect(middleware(request, context, async () => ({ content: [] }))).resolves.toEqual({ content: [] });
    await expect(middleware(request, context, async () => ({ content: [] }))).resolves.toEqual({
      content: [{ type: "text", text: "Rate limit exceeded" }],
      isError: true,
    });
  });

  it("enforces legacy custom rate limiters without consume", async () => {
    const limiter = {
      checkLimit: vi.fn()
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false),
      recordCall: vi.fn(async () => undefined),
      getRemainingCalls: vi.fn(async () => 0),
    };
    const middleware = rateLimitMiddleware({ limiter: limiter as never });
    const request = {
      serverName: "github",
      toolName: "create_issue",
      proxyToolName: "github__create_issue",
      arguments: {},
      raw: { name: "github__create_issue" },
    };
    const context = {
      user: { id: "user-1" },
      log: { info: vi.fn() },
      res: new ResponseController(),
    } as unknown as MiddlewareContext;
    const next = vi.fn(async () => ({ content: [] }));

    await expect(middleware(request, context, next)).resolves.toEqual({ content: [] });
    await expect(middleware(request, context, next)).resolves.toEqual({
      content: [{ type: "text", text: "Rate limit exceeded" }],
      isError: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
    expect(limiter.recordCall).toHaveBeenCalledTimes(1);
  });

  it("does not consume the window bucket when the daily bucket rejects", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new SlidingWindowRateLimiter({
      store,
      keyPrefix: "test",
      maxPerWindow: 2,
      maxDailyCalls: 1,
      windowMs: 60_000,
    });

    await expect(limiter.consume("user-1")).resolves.toBe(true);
    await expect(limiter.consume("user-1")).resolves.toBe(false);

    await expect(store.get("test:window:user-1")).resolves.toBe(1);
  });

  it("does not consume the daily bucket when the window bucket rejects", async () => {
    const store = new MemoryRateLimitStore();
    const limiter = new SlidingWindowRateLimiter({
      store,
      keyPrefix: "test",
      maxPerWindow: 1,
      maxDailyCalls: 2,
      windowMs: 60_000,
    });
    const dayId = new Date().toISOString().slice(0, 10);

    await expect(limiter.consume("user-1")).resolves.toBe(true);
    await expect(limiter.consume("user-1")).resolves.toBe(false);

    await expect(store.get(`test:daily:${dayId}:user-1`)).resolves.toBe(1);
  });

  it("enforces the concurrent rate limit boundary atomically", async () => {
    const limiter = new SlidingWindowRateLimiter({
      store: new MemoryRateLimitStore(),
      maxPerWindow: 2,
      windowMs: 60_000,
    });
    const middleware = rateLimitMiddleware({ limiter });
    const request = {
      serverName: "github",
      toolName: "create_issue",
      proxyToolName: "github__create_issue",
      arguments: {},
      raw: { name: "github__create_issue" },
    };
    const context = {
      user: { id: "user-1" },
      log: { info: vi.fn() },
      res: new ResponseController(),
    } as unknown as MiddlewareContext;

    const results = await Promise.all([
      middleware(request, context, async () => ({ content: [{ type: "text", text: "ok" }] })),
      middleware(request, context, async () => ({ content: [{ type: "text", text: "ok" }] })),
      middleware(request, context, async () => ({ content: [{ type: "text", text: "ok" }] })),
    ]);

    expect(results.filter((result) => !result.isError)).toHaveLength(2);
    expect(results.filter((result) => result.isError)).toHaveLength(1);
  });

  it("does not charge remaining quota when another bucket denies the call", async () => {
    const store = new MemoryRateLimitStore();
    const dayId = new Date().toISOString().slice(0, 10);
    const limiter = new SlidingWindowRateLimiter({
      store,
      maxPerWindow: 2,
      windowMs: 60_000,
      maxDailyCalls: 1,
      keyPrefix: "test",
    });

    await expect(limiter.consume("user-1")).resolves.toBe(true);
    await expect(limiter.consume("user-1")).resolves.toBe(false);

    await expect(store.get("test:window:user-1")).resolves.toBe(1);
    await expect(store.get(`test:daily:${dayId}:user-1`)).resolves.toBe(1);
  });

  it("does not consume secondary quotas after a configured limit is exhausted", async () => {
    class RecordingRateLimitStore extends MemoryRateLimitStore {
      consumedKeys: string[] = [];

      override async consume(key: string, window: number, limit: number): Promise<boolean> {
        this.consumedKeys.push(key);
        return super.consume(key, window, limit);
      }
    }

    const store = new RecordingRateLimitStore();
    const limiter = new SlidingWindowRateLimiter({
      store,
      maxPerWindow: 1,
      windowMs: 60_000,
      maxDailyCalls: 2,
      keyPrefix: "test",
    });
    const key = "user-1:github:create_issue";

    await expect(limiter.consume(key)).resolves.toBe(true);
    store.consumedKeys = [];

    await expect(limiter.consume(key)).resolves.toBe(false);
    expect(store.consumedKeys).toEqual([]);

    await store.reset(`test:window:${key}`);
    await expect(limiter.consume(key)).resolves.toBe(true);
  });

  it("resolves identity from configured headers", async () => {
    const strategy = headerIdentityStrategy({
      userIdHeader: "x-user-id",
      metadataHeaders: { tenant: "x-tenant-id" },
    });

    await expect(
      Promise.resolve(strategy.resolve({ headers: { "x-user-id": "user-1", "x-tenant-id": "tenant-1" } })),
    ).resolves.toEqual({
      id: "user-1",
      metadata: { tenant: "tenant-1" },
    });
  });

  it("returns structured middleware errors and maps upstream errors", () => {
    const controller = new ResponseController();
    expect(controller.fail(FentarisErrorCode.PolicyDenied, "blocked")).toMatchObject({
      isError: true,
      _meta: {
        error: {
          code: FentarisErrorCode.PolicyDenied,
          message: "blocked",
        },
      },
    });

    expect(new DefaultErrorMapper().mapError(new Error("upstream failed"), {})).toEqual({
      code: FentarisErrorCode.UpstreamError,
      message: "upstream failed",
    });
  });
});

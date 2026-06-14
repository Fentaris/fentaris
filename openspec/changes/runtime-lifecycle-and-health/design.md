## Context

Fentaris currently centers runtime behavior around the proxy and transport integrations. Recent changes added config validation, scoped MCP catalog behavior, and profiler/runtime observability planning. The next production-readiness step is to make runtime state and health explicit before adding resilience features such as retry, limits, queues, and circuit breakers.

The design should keep the main DX simple: users configure `fentaris({...})`, optionally add `health(...)`, and can call lifecycle/health methods on the returned runtime/proxy object. Advanced users should be able to register custom checks and inspect server state through a typed health context.

## Goals / Non-Goals

**Goals:**

- Add an official runtime lifecycle state machine.
- Expose lifecycle methods for start, readiness, stop, state inspection, and health inspection.
- Support graceful startup and shutdown with configurable timeouts.
- Add a high-DX `health()` builder with custom `.check(name, handler)` support.
- Add a typed health check context that can inspect runtime, server, group, transport, auth, identity, and policy state.
- Allow health checks to ping/check MCP servers through context helpers where supported.
- Emit lifecycle and health events into the profiler when a profiler is configured.
- Keep the lifecycle/health API extensible enough for later resilience features.

**Non-Goals:**

- Implement retry policies, circuit breakers, fallback routing, queues, request limits, or concurrency limits.
- Add full OpenTelemetry or persistence.
- Add official database/file sinks for health history.
- Add broad public documentation pages.
- Replace the current proxy object with a separate unrelated runtime object.

## Decisions

### The returned Fentaris object is the lifecycle runtime

`fentaris(config)` should continue to return the main runtime/proxy object, but that object should implement official lifecycle and health methods.

Example direction:

```ts
const proxy = fentaris({
  servers: [...],
  groups: [...],
  health: health().check("linear", async ctx => {
    return ctx.server("linear").ping();
  }),
});

await proxy.start();
await proxy.ready();
const report = await proxy.health();
await proxy.stop();
```

Rationale: introducing a separate wrapper object too early would confuse the current mental model. Adding a clear lifecycle interface to the main object preserves DX while still allowing a richer internal runtime model.

Alternatives considered:

- Return a new `FentarisRuntime` wrapper that owns `McpProxy`: clean architecture, but a bigger public API shift.
- Keep lifecycle only on `McpProxy`: simpler internally, but less future-proof if Fentaris grows beyond proxy transport shape.

### Lifecycle state is explicit and monotonic where practical

The runtime should track:

- `created`
- `starting`
- `ready`
- `degraded`
- `stopping`
- `stopped`
- `failed`

State transitions should be guarded so invalid calls produce clear errors or no-op behavior where appropriate. `start()` should be idempotent when already starting/ready, and `stop()` should be safe when already stopped.

Rationale: later resilience features need reliable state. The profiler also needs authoritative lifecycle transitions rather than inferred log messages.

### Health uses a builder plus object config

The primary custom API should be:

```ts
health()
  .check("linear", async ctx => ctx.server("linear").ping())
  .check("database", async () => ({ status: "ok" }));
```

A simple object config can support basic defaults:

```ts
fentaris({
  health: {
    checks: true,
    include: ["runtime", "mcp", "transport"],
  },
});
```

Rationale: builder syntax gives the same composable DX as profiler, while object config keeps default health usable with little setup.

### Health context exposes safe runtime inspection helpers

Health check handlers should receive a typed context with helpers such as:

- `ctx.runtime.state()`
- `ctx.server(name).state()`
- `ctx.server(name).ping()`
- `ctx.server(name).health()`
- `ctx.group(id).servers()`
- `ctx.transport(nameOrType).state()`
- `ctx.policy.state()` if available

The context should expose safe metadata and inspection methods, not raw internals that allow accidental mutation.

Rationale: users explicitly asked to ping/check servers from context and inspect server state. Keeping this behind methods avoids leaking unstable internal structures.

### Health checks return structured results

Health checks should return a normalized result:

```ts
type HealthStatus = "ok" | "degraded" | "down" | "unknown";
```

Each result should include name, status, optional message, duration, checkedAt, metadata, and normalized error if the check failed.

Rationale: structured health is easier to test, render, log, and feed into later resilience logic.

### Profiler integration is event emission only

Lifecycle and health should emit profiler events when the profiler is configured:

- `runtime.start`
- `runtime.ready`
- `runtime.degraded`
- `runtime.stop`
- `runtime.failed`
- `health.check.start`
- `health.check.success`
- `health.check.error`
- `health.status`

Rationale: profiler remains the observability output layer. Lifecycle/health owns state and checks; it should not duplicate logging or sink logic.

### Built-in health checks stay conservative

Built-in checks should start with runtime state, MCP server availability/ping where supported, transport exposure state, and scoped group/server visibility. Checks that need expensive network behavior should be opt-in or timeout-bound.

Rationale: health should not become a hidden source of latency or side effects.

## Risks / Trade-offs

- [Risk] Adding lifecycle methods to the proxy blurs proxy and runtime boundaries. -> Mitigation: define a small lifecycle interface and keep internals modular so a future wrapper can delegate to the same lifecycle controller.
- [Risk] Health checks can hang. -> Mitigation: add per-check timeout support and normalize timeout failures.
- [Risk] `ctx.server(name).ping()` may not be supported by every transport/server. -> Mitigation: return `unknown` or `degraded` with a clear reason when ping is unavailable.
- [Risk] Health checks may expose sensitive metadata. -> Mitigation: return safe metadata only and pass health events through profiler redaction.
- [Risk] Built-in checks can become too opinionated. -> Mitigation: ship conservative defaults and make custom checks first-class.

## Migration Plan

1. Add lifecycle and health contracts as additive public API.
2. Add an internal lifecycle controller used by the existing proxy/runtime object.
3. Add health builder/config normalization.
4. Add health context helpers backed by existing server catalog and runtime state.
5. Emit profiler lifecycle/health events when the profiler is present.
6. Preserve existing proxy construction and start behavior as compatibility paths where possible.

Rollback is additive: lifecycle/health can be disabled or left unused while existing proxy behavior remains available.

## Open Questions

- Should `ready()` wait for all configured MCP server checks, only runtime transport startup, or a configurable readiness policy?
- Should server ping be a dedicated extension contract that transports can implement, or should it be best-effort through existing MCP operations?
- Should default health include group-scoped server visibility checks, or only expose those through custom checks initially?
- Should health checks run only on demand, or should optional background periodic checks be included later?

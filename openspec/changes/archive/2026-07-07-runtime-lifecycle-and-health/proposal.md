## Why

Fentaris needs a predictable runtime lifecycle and health model before adding deeper resilience features. Users should be able to start, stop, inspect, and health-check the runtime and its MCP/transport components with a clean DX and typed context.

## What Changes

- Add official runtime lifecycle states: `created`, `starting`, `ready`, `degraded`, `stopping`, `stopped`, and `failed`.
- Add lifecycle methods for starting, waiting for readiness, stopping, and inspecting runtime state.
- Add graceful startup and shutdown behavior with configurable startup and shutdown timeouts.
- Add a health API with both simple object config and builder syntax.
- Support custom health checks through `health().check(name, handler)`.
- Provide a typed `HealthCheckContext` that can inspect server state, run MCP server ping/check helpers, inspect runtime state, and access safe group/server metadata.
- Allow health checks to target runtime, MCP servers, groups, transports, auth/identity, policy, and custom dependencies.
- Emit lifecycle and health events through the profiler when available, without duplicating logging logic.
- Keep resilience features such as retry, circuit breaker, fallback routing, concurrency limits, and queue/reject policies out of this change.
- Keep broad public documentation out of scope; add targeted code comments where lifecycle/health boundaries are non-obvious.

## Capabilities

### New Capabilities

- `runtime-lifecycle-and-health`: Covers runtime lifecycle state, start/ready/stop behavior, graceful shutdown, health checks, health context, server ping/state inspection, and profiler-linked lifecycle/health events.

### Modified Capabilities

- None.

## Impact

- Affects the high-level `fentaris(...)` runtime shape, proxy runtime lifecycle, transport exposure lifecycle, MCP server state inspection, and profiler event integration.
- Adds new public contracts for lifecycle state, health status, health checks, health context, and health builder configuration.
- Requires focused tests for lifecycle transitions, startup/shutdown timeout handling, health builder normalization, custom health checks, MCP server health context, and profiler event emission.
- Does not add resilience/limits implementation; that remains a separate follow-up plan.

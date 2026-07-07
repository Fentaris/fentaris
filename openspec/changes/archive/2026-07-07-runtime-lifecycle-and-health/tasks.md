## 1. Lifecycle Contracts

- [x] 1.1 Add public runtime lifecycle state and lifecycle metadata types.
- [x] 1.2 Add public lifecycle method contracts for `start`, `ready`, `stop`, `state`, and `health`.
- [x] 1.3 Add startup and shutdown timeout option types and config normalization.
- [x] 1.4 Export lifecycle contracts from the intended public entry points.

## 2. Lifecycle Controller

- [x] 2.1 Implement an internal lifecycle controller with guarded state transitions.
- [x] 2.2 Make `start()` idempotent while the runtime is starting or ready.
- [x] 2.3 Make `stop()` safe when the runtime is already stopping or stopped.
- [x] 2.4 Normalize startup, shutdown, and invalid transition failures into runtime errors.
- [x] 2.5 Add targeted comments around lifecycle state transition responsibilities.

## 3. Health Contracts And Builder

- [x] 3.1 Add health status, health check result, health report, and health check handler types.
- [x] 3.2 Add `health()` builder with `.check(name, handler)` and basic option methods.
- [x] 3.3 Add simple object health config support and normalization.
- [x] 3.4 Add per-check timeout configuration.
- [x] 3.5 Export health contracts from the intended public entry points.

## 4. Health Context

- [x] 4.1 Implement typed health check context for runtime state inspection.
- [x] 4.2 Add `ctx.server(name).state()`, `ctx.server(name).ping()`, and `ctx.server(name).health()` helpers.
- [x] 4.3 Add `ctx.group(id).servers()` safe scoped server inspection.
- [x] 4.4 Add safe transport, policy, auth, and identity inspection helpers where runtime data exists.
- [x] 4.5 Normalize unsupported ping/check behavior into explicit unknown or degraded health results.
- [x] 4.6 Add targeted comments around safe context access versus mutable internals.

## 5. Built-In Health Checks

- [x] 5.1 Add runtime lifecycle built-in health check.
- [x] 5.2 Add MCP server availability/ping built-in health checks where supported.
- [x] 5.3 Add transport exposure state built-in health checks.
- [x] 5.4 Add scoped group/server visibility built-in health checks.
- [x] 5.5 Aggregate individual checks into overall `ok`, `degraded`, `down`, or `unknown` status.

## 6. Runtime And Profiler Integration

- [x] 6.1 Add lifecycle methods to the main Fentaris runtime/proxy object.
- [x] 6.2 Wire startup and shutdown through existing exposure transport/resource cleanup paths.
- [x] 6.3 Emit profiler events for runtime start, ready, degraded, stop, and failed transitions.
- [x] 6.4 Emit profiler events for health check start, success, error, timeout, and final health status.
- [x] 6.5 Ensure profiler redaction applies to health and lifecycle event metadata.

## 7. Tests

- [x] 7.1 Add tests for lifecycle state transitions and idempotent start/stop behavior.
- [x] 7.2 Add tests for startup and shutdown timeout failures.
- [x] 7.3 Add tests for health builder and object config normalization.
- [x] 7.4 Add tests for custom health checks, thrown check errors, and check timeouts.
- [x] 7.5 Add tests for server ping/state helpers and unsupported ping behavior.
- [x] 7.6 Add tests for group-scoped server inspection.
- [x] 7.7 Add tests for built-in health checks and overall status aggregation.
- [x] 7.8 Add tests for lifecycle and health profiler event emission.

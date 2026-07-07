## 1. Profiler And Event Contracts

- [x] 1.1 Add `RuntimeEventMap`, `RuntimeEventName`, and typed runtime event payload contracts.
- [x] 1.2 Add profiler track/category, severity/level, filter, and handler option types.
- [x] 1.3 Add `ProfilerSink`, custom function sink, logger sink adapter, and pretty sink contracts.
- [x] 1.4 Add the public `profiler()` builder with `pretty`, `level`, `track`, `where`, `on`, and `sink` methods.
- [x] 1.5 Add simple object profiler config support and normalization into the internal profiler model.
- [x] 1.6 Export the official profiler and runtime event types from the intended public entry points.

## 2. Runtime Error Model

- [x] 2.1 Add `FentarisRuntimeError` base class with stable code, severity, cause, hints, and contextual metadata.
- [x] 2.2 Add specialized runtime errors for MCP, transport, policy, extension, and timeout failures.
- [x] 2.3 Implement runtime error normalization for unknown thrown values and third-party errors.
- [x] 2.4 Add helpers for converting normalized errors into profiler error events.
- [x] 2.5 Add pretty runtime error rendering separated from structured error data.

## 3. Redaction And Safe Payloads

- [x] 3.1 Add profiler redaction normalization with secure defaults for tokens, secrets, credentials, authorization, passwords, and API keys.
- [x] 3.2 Apply redaction before dispatching events to sinks and handlers.
- [x] 3.3 Ensure normalized runtime errors are redacted before they are rendered or written to sinks.
- [x] 3.4 Add custom redaction rule support for keys, paths, and custom redaction functions.

## 4. Profiler Runtime Engine

- [x] 4.1 Implement profiler event dispatch with category, level, server, group, user, operation, and duration filters.
- [x] 4.2 Support multiple sinks and event handlers without duplicating instrumentation logic.
- [x] 4.3 Isolate sink failures by default and emit normalized profiler or extension errors for sink failures.
- [x] 4.4 Add optional strict sink failure behavior if supported by the finalized API.
- [x] 4.5 Add focused architecture comments around profiler, sink, redaction, and event dispatch boundaries.

## 5. Runtime Integration

- [x] 5.1 Integrate profiler config resolution into `fentaris`/proxy config normalization.
- [x] 5.2 Preserve existing `Logger` behavior and adapt logger output into the profiler path where practical.
- [x] 5.3 Emit lifecycle events for start, ready, degraded, stop, and runtime error states.
- [x] 5.4 Emit MCP call start, success, error, timeout, and duration events.
- [x] 5.5 Emit policy allow/deny events with safe decision metadata.
- [x] 5.6 Emit transport error events from exposure transports.
- [x] 5.7 Emit extension, hook, middleware, route, and sink failure events at the relevant boundaries.
- [x] 5.8 Add timeout/duration metadata to runtime operations where missing.

## 6. Tests

- [x] 6.1 Add type-level tests for event name autocomplete behavior and payload narrowing.
- [x] 6.2 Add unit tests for profiler builder normalization and object config normalization.
- [x] 6.3 Add unit tests for filters by server, group, user, operation, level, category, and duration.
- [x] 6.4 Add unit tests for custom sinks, multiple sinks, logger sink compatibility, and sink failure isolation.
- [x] 6.5 Add unit tests for runtime error taxonomy and normalization.
- [x] 6.6 Add tests for default and custom redaction across events and errors.
- [x] 6.7 Add integration tests for automatic MCP call, policy, timeout, transport, extension, and lifecycle instrumentation.
- [x] 6.8 Add snapshot or structured assertions for pretty runtime error rendering.

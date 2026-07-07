## Why

Fentaris now has a public extension surface, scoped MCP catalog, and config validation, but the runtime still needs a coherent production-readiness layer for failures, logs, timeouts, lifecycle state, and observability. This change makes runtime behavior visible and traceable by default while preserving a high-quality DX for both simple and advanced users.

## What Changes

- Add a high-level profiler API that can be configured in `fentaris({ profiler })` with both builder syntax and simple object presets.
- Introduce typed runtime events with TypeScript literal unions and event payload maps so IntelliSense can discover event names and event-specific fields.
- Add automatic instrumentation for runtime lifecycle, MCP calls, policy decisions, transport failures, extension failures, timeouts, and runtime errors.
- Introduce a runtime error taxonomy for normalized Fentaris runtime, MCP, transport, timeout, policy, and extension errors.
- Add structured error normalization so unknown thrown values and third-party failures preserve cause chains while gaining Fentaris context.
- Add profiler filters for common dimensions such as server, group, user, operation, severity, category, and duration.
- Add profiler sink contracts so events can be written to console, the existing logger, JSON-oriented sinks, or user-defined sinks.
- Keep the existing `Logger` compatible by adapting it into the profiler model instead of removing it.
- Add runtime lifecycle and health-oriented events for start, ready, degraded, stop, and runtime error states.
- Add default redaction for secrets in runtime events, logs, error metadata, and sink payloads.
- Keep documentation changes out of scope for now; add targeted code comments where architecture decisions are non-obvious.

## Capabilities

### New Capabilities

- `production-readiness-runtime-profiler`: Covers runtime profiling, typed runtime events, structured runtime errors, automatic instrumentation, redaction, filters, sink extensibility, and minimal lifecycle readiness.

### Modified Capabilities

- None.

## Impact

- Affects core public API shape around `fentaris({ profiler })`, profiler builder exports, runtime event types, and sink/error contracts.
- Integrates with `McpProxy`, proxy event emission, middleware/hook boundaries, scoped MCP catalog context, transport exposure adapters, config validation, and existing logging primitives.
- May require focused tests for runtime event typing, profiler filtering, sink dispatch, redaction, error normalization, timeout events, and compatibility with the current `Logger`.
- No new external documentation is required in this change.

## Context

The core already has a `Logger`, proxy event hooks, lifecycle hooks, config validation, scoped MCP server bindings, and extension contracts. These pieces are useful but they do not yet form a single production-readiness model: runtime errors are not consistently normalized, logging is partly manual, timeouts and durations are not represented as first-class events, and advanced users do not have one clear API for routing runtime telemetry to custom systems.

This design introduces a profiler layer above the current logger. The profiler receives typed runtime events, applies filtering/redaction/rules, and writes to sinks. The existing logger remains compatible as one possible sink, while the profiler becomes the main mental model for automatic runtime observability.

## Goals / Non-Goals

**Goals:**

- Provide a high-DX profiler builder for production-readiness instrumentation.
- Support a simple object config for users who want defaults with minimal syntax.
- Make runtime events strongly typed so IntelliSense discovers event names and event-specific payload fields.
- Automatically emit structured events for lifecycle, MCP calls, policy decisions, timeouts, transport failures, extension failures, and runtime errors.
- Normalize runtime errors into Fentaris error classes with stable codes, causes, severity, hints, and safe contextual metadata.
- Allow users to filter profiler output by server, group, user, operation, event category, severity, and duration.
- Allow multiple sinks, including pretty console output, adapter sinks for the existing logger, JSON-oriented sinks, and custom user sinks.
- Redact secrets by default before events leave the runtime boundary.
- Add targeted code comments for architectural decisions instead of adding public docs to the current documentation set.

**Non-Goals:**

- Rebuild the public documentation site or add broad documentation pages.
- Add full OpenTelemetry integration.
- Add official database sinks such as Postgres, Redis, ClickHouse, or Elasticsearch.
- Add dashboarding, persistence, or distributed tracing infrastructure.
- Add runtime MCP add/remove support.
- Add circuit breakers, fallback routing, or advanced retry policies.
- Make profiler sinks directly mutate runtime behavior.

## Decisions

### Profiler is the public DX layer above Logger

The public API should prefer:

```ts
const proxy = fentaris({
  servers: [...],
  groups: [...],
  profiler: profiler()
    .pretty()
    .level("info")
    .track("errors", "warnings", "timeouts", "policy", "mcp")
    .sink(customSink),
});
```

The low-friction object form remains available:

```ts
fentaris({
  profiler: {
    preset: "pretty",
    level: "warn",
    track: ["errors", "timeouts", "policy"],
  },
});
```

Rationale: builder syntax matches the desired framework DX for composable advanced behavior, while object config keeps the common case short. The current `Logger` should not be removed; it should be adapted as a sink/driver so existing users are not forced to migrate immediately.

Alternatives considered:

- Only extend `Logger`: simpler, but logging alone is too narrow for typed events, metrics, filters, durations, and runtime error correlation.
- Only expose event hooks: flexible, but too manual and weak for default production readiness.
- Only use object config: concise, but less expressive for custom sinks and composable filters.

### Runtime events are typed by an event map

The core should define a `RuntimeEventMap` and derive `RuntimeEventName` and `RuntimeEvent` from it. Event handlers and filters should use the event name to infer the payload type.

Example direction:

```ts
type RuntimeEventMap = {
  "runtime.start": RuntimeStartEvent;
  "mcp.call.timeout": McpCallTimeoutEvent;
  "policy.denied": PolicyDeniedEvent;
};

type RuntimeEventName = keyof RuntimeEventMap;
type RuntimeEvent<N extends RuntimeEventName = RuntimeEventName> = RuntimeEventMap[N];
```

Rationale: event strings are still ergonomic, but TypeScript can autocomplete names and narrow payloads. This protects DX as the event surface grows.

Alternatives considered:

- Enum-only event names: discoverable, but less ergonomic and less consistent with existing string event APIs.
- Untyped string names: easiest to implement, but poor DX and fragile for third-party extension authors.

### Profiler sinks observe; runtime actions are separate

`ProfilerSink` should be an output contract:

```ts
type ProfilerSink = {
  write(event: RuntimeEvent): void | Promise<void>;
};
```

Sinks should not directly own runtime control operations. Future countermeasures such as circuit breaking, disabling a server, or fallback routing should live in a separate runtime action/supervisor layer that can subscribe to events.

Rationale: logging and control flow must remain understandable. A sink that writes to a database should not also unexpectedly alter runtime state.

Alternatives considered:

- Let sinks mutate runtime context: powerful, but surprising and hard to reason about.
- Ban custom reactions completely: safer, but too limiting for advanced users.

### Automatic instrumentation is required at runtime boundaries

Instrumentation should be emitted automatically around:

- proxy lifecycle start/ready/degraded/stop/error
- downstream sessions
- upstream MCP capability operations
- tool calls
- policy decisions
- middleware and route errors
- hook and extension errors
- transport exposure errors
- timeout/cancellation paths

Rationale: users should not need to manually call `logger.info()` for basic observability. The profiler should make normal runtime behavior visible by default.

Alternatives considered:

- Keep instrumentation manual: less code, but bad production-readiness DX.
- Instrument only tool calls: useful but incomplete because failures often happen in auth, policy, transport, lifecycle, or extension code.

### Runtime errors are normalized before emission

Unknown thrown values and third-party errors should be converted into Fentaris runtime error classes with stable codes, severity, cause, context, and hints.

Initial classes:

- `FentarisRuntimeError`
- `FentarisMcpError`
- `FentarisTransportError`
- `FentarisPolicyError`
- `FentarisExtensionError`
- `FentarisTimeoutError`

Rationale: production readiness depends on errors being actionable and safe to log. Config validation already moved toward structured diagnostics; runtime failures need an equivalent structured model.

Alternatives considered:

- Reuse generic `Error`: too little context and no stable code contract.
- Use only config diagnostics for runtime: diagnostics and runtime exceptions overlap but serve different lifecycles.

### Redaction happens before sink dispatch

Profiler events should be redacted before they are passed to sinks by default. Redaction should cover common sensitive keys, credential metadata, authorization headers, tokens, API keys, passwords, secrets, and user-configurable paths.

Rationale: users should be able to add custom sinks without accidentally leaking credentials.

Alternatives considered:

- Ask each sink to redact: flexible, but easy to get wrong.
- Disable metadata by default: safer but removes too much value from production debugging.

### Health and lifecycle remain minimal

This change should establish lifecycle events and a basic health/degraded state, but not implement a full supervisor or circuit breaker. Runtime lifecycle should expose enough state for events and health checks without locking the project into a heavy orchestration model.

Rationale: pre-alpha needs predictable start/stop/error behavior and traceability, not a full platform.

Alternatives considered:

- Build a complete supervisor now: powerful but likely over-scoped.
- Skip lifecycle state: leaves production readiness incomplete.

## Risks / Trade-offs

- [Risk] Event names become public API too early and hard to change. -> Mitigation: start with a small, deliberate event map and keep internal-only events unexported.
- [Risk] Profiler overlaps with existing proxy hooks. -> Mitigation: define profiler as observability, while proxy hooks remain behavior/middleware extension points.
- [Risk] Custom sinks can be slow or throw. -> Mitigation: isolate sink failures, normalize them as profiler/extension errors, and avoid breaking MCP calls unless explicitly configured.
- [Risk] Redaction may remove useful debugging details. -> Mitigation: allow opt-in custom redaction rules and safe structured context fields.
- [Risk] Builder API may grow too large. -> Mitigation: keep the first surface to presets, level, track, where/filter, on, and sink.
- [Risk] Pretty error output can become tightly coupled to event data. -> Mitigation: keep renderers separate from structured events and errors.

## Migration Plan

1. Add profiler/event/error contracts without removing existing logger APIs.
2. Adapt `Logger` into the profiler sink path while preserving direct logger usage.
3. Add automatic instrumentation at the runtime boundaries with focused behavior tests.
4. Move existing `autoLog` behavior onto profiler defaults where practical, keeping compatibility aliases if needed.
5. Add deprecation guidance only in code comments or release notes later; do not change public docs in this plan.

Rollback is straightforward if the profiler is introduced as additive API: keep `Logger` and existing hooks working, and disable profiler dispatch by default if regressions appear.

## Open Questions

- Should the public option be named `profiler`, `observer`, `monitor`, or `telemetry`? Current preference is `profiler` for DX, with internal names like `RuntimeEvent` and `RuntimeObserver`.
- Should `autoLog` become an alias for a default profiler preset, or remain independent until a later cleanup?
- Should JSON/JSONL file sink be included in the first implementation, or should only function/custom sink plus pretty/logger adapters ship initially?
- Should sink failures be logged and swallowed by default, or should strict mode allow sink failures to fail the current runtime operation?

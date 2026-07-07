## Why

The current Fentaris core exposes proxy/middleware/hooks, but the governance-centric syntax (policy, registry/secrets, rate limiting, identity, isolation, and richer logging) is not implemented. We need a scalable, production-ready foundation so teams can enforce policy and operate multi-tenant proxies without bespoke glue code.

## What Changes

- Introduce a first-class Policy engine (RBAC-style permissions, approvals, policy metadata) integrated into middleware and tool discovery.
- Add Registry/Secrets APIs with MemoryRegistry and Redis-backed implementations for per-user secrets and tokens.
- Add distributed Rate Limiting and Quotas with pluggable stores (Redis/KV) and middleware hooks.
- Add Identity/Auth resolution at the proxy edge (strategy-based user extraction).
- Add new transport adapters (HTTP transport) and improve extensibility for SSE transport.
- Add per-user Isolation runtime (queueing, timeouts, worker/pool abstraction) for scalable multi-tenant execution.
- Add Logger drivers and auto-log pipeline (structured request/response/timing) with Redis driver option.
- Add lifecycle hooks and error mapping for consistent auditing and observability.

## Capabilities

### New Capabilities
- `policy-engine`: Policy objects, ToolPermission, approvals, metadata, and listTools filtering.
- `registry-secrets`: Registry interface plus MemoryRegistry and Redis-backed registry for per-user secrets.
- `rate-limiting`: RateLimiter and quota enforcement with distributed store support.
- `identity-auth`: Edge auth/identity resolution into UserContext with strategy hooks.
- `transport-http`: HTTP transport adapter for MCP servers.
- `isolation-runtime`: Per-user isolation/queue/pool runtime for scalable server execution.
- `logging-observability`: Logger drivers, auto-log pipeline, and event/lifecycle hooks.
- `error-mapping`: Standardized upstream error mapping to MCP errors and policy denies.

### Modified Capabilities
- (none)

## Impact

Core runtime APIs (`McpProxy`, `McpServer`, middleware context, logger), new packages for registry/rate-limit/identity, additional transports, and documentation updates across guides and reference. Dependencies likely include Redis/KV drivers and optional auth helpers.

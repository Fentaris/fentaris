## Context

Fentaris already ships core proxy, transports (stdio), middleware, hooks, and a structured logger. The missing pieces are governance and operational primitives needed to realize the proposed syntax: policy enforcement, secrets registry, distributed rate limiting, identity resolution, isolation runtime, HTTP transport, and richer logging/autologging. The design must scale across multiple Fentaris instances and support multi-tenant usage without coupling governance to individual servers.

## Goals / Non-Goals

**Goals:**
- Provide first-class governance primitives (policy, permissions, approvals, listTools filtering) that integrate cleanly with existing middleware/hooks.
- Support distributed, scalable enforcement (rate limits, quotas, secrets) via pluggable stores (Redis/KV).
- Introduce identity/auth resolution at the proxy edge to populate UserContext consistently.
- Add HTTP transport and an extensible pattern for SSE transport adapters.
- Add isolation runtime abstractions (queue/pool/timeout) to scale per-user execution.
- Expand logging with pluggable drivers and auto-log pipeline for requests, responses, and timings.
- Standardize error mapping to MCP errors for reliable client behavior.

**Non-Goals:**
- Building a full auth provider (OAuth, SSO). We only define interfaces and hooks.
- Providing a complete policy DSL with conditional logic beyond per-tool permissions.
- Shipping a production orchestration layer for containers or autoscaling; the isolation runtime is an interface with a default in-process implementation.

## Decisions

1. **Policy engine as middleware-integrated core type**
   - Define `Policy`, `ToolPermission`, and evaluation APIs in core, with policy evaluation exposed via middleware context.
   - Alternative: a standalone middleware-only policy plugin. Rejected to keep syntax consistent and reduce glue code.

2. **Registry/Secrets via pluggable interface**
   - Add `Registry` interface with `getUser`, `getSecrets`, and `getTokens` methods; implement `MemoryRegistry` and `RedisRegistry`.
   - Alternative: store secrets directly in UserContext. Rejected due to security and caching concerns.

3. **Rate limiting with distributed store contract**
   - Add `RateLimiter` that depends on a `RateLimitStore` interface (Redis/KV) and supports sliding window.
   - Alternative: in-memory limiter only. Rejected for multi-instance scalability.

4. **Identity/auth as edge strategy**
   - Add `identity` configuration on `McpProxy` to resolve UserContext from HTTP requests (header-based, token-based, custom resolver).
   - Alternative: require users to pass `user` resolver directly. Keep backward compatibility, but provide higher-level strategies for common cases.

5. **Isolation runtime as adapter**
   - Add `Isolation` interface with queueing/timeout semantics; default in-process queue implementation.
   - Alternative: embed isolation in `McpServer` without abstraction. Rejected to keep transport/runtime decoupled.

6. **HTTP transport as first-class adapter**
   - Add `HttpTransport` implementing the FentarisTransport interface.
   - Provide SSE adapter pattern but keep concrete SSE implementation optional.

7. **Logging/auto-log pipeline**
   - Extend Logger to support `autoLog` and add driver integrations (Redis driver).
   - Alternative: implement auto-logging in middleware guides only. Rejected to avoid inconsistent behavior.

8. **Error mapping contract**
   - Add `ErrorMapper` or `res.fail(code, message)` to standardize MCP errors across transports and policy denies.

## Risks / Trade-offs

- **Complexity creep** → Mitigation: keep interfaces minimal; ship sane defaults and leave advanced policies to user code.
- **Distributed consistency (rate limits/registry)** → Mitigation: define store contracts with clear semantics; default to Redis for distributed use.
- **Backward compatibility** → Mitigation: preserve existing APIs; new features are additive and opt-in.
- **Isolation runtime performance** → Mitigation: default lightweight queue; allow external runtimes to be injected.


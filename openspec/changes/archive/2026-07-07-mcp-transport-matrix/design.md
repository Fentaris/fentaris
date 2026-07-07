## Context

`@fentaris/core` currently separates upstream MCP servers behind `FentarisTransport`, but `McpProxy.start()` owns the downstream HTTP server directly. Upstream stdio support is native through the MCP SDK, while HTTP/HTTPS support is a simple REST-like adapter that posts to `/listTools` and `/callTool`, not a full MCP Streamable HTTP client. SSE upstreams are documented as a custom adapter pattern but are not implemented.

This change introduces a transport matrix: Fentaris can connect to native MCP upstreams over stdio, Streamable HTTP/HTTPS, and SSE, and can expose the aggregated proxy over HTTP by default with optional stdio and SSE exposure. Governance features such as identity, policy, registry secrets, rate limiting, hooks, logging, and isolation must continue to operate at the proxy edge regardless of the chosen downstream transport.

## Goals / Non-Goals

**Goals:**

- Add native MCP upstream transports for Streamable HTTP/HTTPS and SSE.
- Keep `StdioTransport` as the native stdio upstream and document its per-user env and isolation behavior.
- Add a shared auth model for HTTP-family upstream transports.
- Decouple proxy request handling from Node HTTP server creation so HTTP, stdio, and SSE exposure can reuse the same aggregation pipeline.
- Preserve backward compatibility for `new McpProxy(...).start()` as HTTP exposure on the existing default path.
- Provide focused tests and docs for the supported transport combinations.

**Non-Goals:**

- Do not implement a full OAuth authorization-code, device-code, client-credentials, discovery, or refresh-token flow.
- Do not add container or process sandboxing beyond the existing isolation abstraction.
- Do not require all downstream transports to support every HTTP-only feature such as request headers.
- Do not replace policy, identity, registry, or logging semantics from the governance work.

## Decisions

### Split proxy runtime from downstream exposure

Introduce a reusable proxy runtime surface inside `McpProxy` that can create an MCP SDK server and bind list/call handlers without also creating a Node HTTP listener. Downstream exposure adapters will own protocol-specific server wiring and call into that runtime.

Alternative considered: keep adding modes to `McpProxy.start()`. This would preserve a single method, but it would keep HTTP session logic mixed with stdio/SSE behavior and make lifecycle cleanup harder to reason about.

### Keep HTTP as the default downstream transport

`McpProxy.start()` will continue to start HTTP Streamable MCP on the configured `port` and `path`. New APIs can add explicit transport selection, such as `proxy.listen(new HttpProxyTransport(...))` or equivalent option-based construction, while preserving existing call sites.

Alternative considered: replace `start()` with a new required transport API. This would make the model cleaner immediately, but it would be an unnecessary breaking change.

### Model upstream and downstream transports separately

Upstream transports implement the existing `FentarisTransport` shape because they behave as MCP clients toward configured servers. Downstream proxy exposure transports will use a separate interface because they behave as MCP servers toward external clients and need different lifecycle and identity inputs.

Alternative considered: reuse `FentarisTransport` for both directions. That conflates client and server semantics and cannot represent downstream session creation cleanly.

### Implement native MCP HTTP/HTTPS upstream with SDK protocol semantics

Add a dedicated Streamable HTTP upstream transport that talks to MCP-compatible HTTP endpoints, manages initialize/session behavior, forwards `listTools` and `callTool`, and supports both `http://` and `https://` URLs through the same code path.

Alternative considered: evolve the current `HttpTransport` REST-like adapter. That would blur incompatible protocols; the current adapter should either remain as a simple adapter with explicit naming or be deprecated after native MCP HTTP is available.

### Implement native MCP SSE upstream as a first-class transport

Add an SSE upstream transport that manages the SSE connection lifecycle, correlates requests/responses through the MCP SDK transport where possible, and closes open streams on proxy shutdown. It should reconnect only when the SDK transport or implementation can do so safely.

Alternative considered: keep SSE as documentation-only custom transport. That blocks common MCP server deployments and weakens Fentaris as a central gateway.

### Use a shared HTTP-family auth resolver

HTTP/HTTPS and SSE upstream transports will accept static headers plus structured auth helpers for bearer tokens, API keys, and async token/header resolvers. The resolver receives user context so per-user credentials from registry secrets/tokens can be applied before upstream calls.

Alternative considered: define separate auth options per transport. That creates inconsistent behavior for equivalent protocols and makes docs/tests noisier.

### Treat stdio auth as environment configuration

Stdio has no HTTP headers or OAuth exchange. Fentaris will support stdio credentials through `McpServer.env(user)`, registry-backed secrets/tokens, and env-aware transport copies. Per-user isolation remains controlled by `McpServer.isolation`.

Alternative considered: add auth options directly to `StdioTransport`. That would duplicate `env` and imply protocol-level auth that stdio does not have.

## Risks / Trade-offs

- Native HTTP and SSE MCP SDK APIs may differ across SDK versions -> Pin or verify SDK version behavior in tests and isolate SDK-specific code inside transport classes.
- Multiple downstream transports can create subtle lifecycle leaks -> Centralize close handling and test session cleanup for each exposure type.
- Stdio downstream cannot resolve identity from HTTP headers -> Require explicit user configuration or authenticated wrapper context for stdio exposure, and document that header-based identity only applies to HTTP/SSE requests.
- SSE support can be fragile around reconnects and long-lived streams -> Start with deterministic lifecycle and close behavior before adding reconnect policies.
- Keeping the old simple `HttpTransport` may confuse users -> Rename, document, or mark it as a simple HTTP adapter while introducing the native MCP HTTP transport with a distinct name.

## Migration Plan

1. Add native upstream transport classes and tests without changing existing `McpProxy.start()` behavior.
2. Extract downstream HTTP handling into a proxy exposure adapter while keeping `start()` as a compatibility wrapper.
3. Add stdio and SSE proxy exposure adapters behind the new downstream transport interface.
4. Update exports and docs with clear naming for native MCP transports versus simple HTTP adapters.
5. Roll back by keeping existing `McpProxy.start()` and `StdioTransport` paths untouched while removing only the new transport exports if necessary.

## Open Questions

- Should the existing `HttpTransport` be renamed to `SimpleHttpTransport`, deprecated, or left as-is with stronger documentation?
- Should downstream stdio exposure support only a static user context, or also accept an async identity resolver configured outside HTTP headers?
- Should downstream SSE exposure be implemented in this change if the MCP SDK does not provide a stable server-side SSE transport, or should it be a Fentaris-owned adapter?

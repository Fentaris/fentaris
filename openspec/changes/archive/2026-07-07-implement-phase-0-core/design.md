## Context

`@fentaris/core` currently has no source implementation. The nearby sandbox proves the useful base pattern: create an MCP server, aggregate upstream tools, prefix names to preserve routing, and forward calls to the selected upstream. The framework version should extract that behavior into reusable classes with a public API that can later host policy, registry, logging, approval, and isolation features.

The first implementation target is a usable Fase 0 core: one streamable HTTP proxy endpoint, stdio upstream support, namespaced tool routing, and a middleware pipeline around tool calls.

## Goals / Non-Goals

**Goals:**

- Provide an importable `@fentaris/core` API with `McpProxy`, `McpServer`, `StdioTransport`, `Logger`, and core middleware/context types.
- Use object-style configuration constructors so future options can be added without positional API churn.
- Aggregate tools from multiple upstream MCP servers and expose stable proxied names.
- Route `call_tool` requests through middleware before forwarding to the upstream.
- Allow middleware to deny a call with an MCP tool error response.
- Serve the proxy over streamable HTTP for MCP clients.

**Non-Goals:**

- RBAC policy engine, tool permission objects, quotas, or approval workflows.
- User registry implementations, Redis stores, or persistent logging drivers.
- Docker isolation, process pools, autoscaling, or per-user upstream environments beyond static/env-function support.
- Resource and prompt proxying. These can follow the same namespace approach after tool proxying is stable.

## Decisions

### Use the official MCP SDK

The core will depend on `@modelcontextprotocol/sdk` rather than implementing JSON-RPC or MCP transport details directly.

Alternative considered: hand-roll the protocol layer. That would reduce dependencies but creates unnecessary protocol risk and slows down the framework.

### Start with streamable HTTP server transport

`McpProxy.start()` will create a Node HTTP server and attach `StreamableHTTPServerTransport` sessions. This matches current MCP transport direction and keeps Cursor/Claude-style gateway use cases practical.

Alternative considered: expose only an in-memory MCP server object. That is useful for tests, but it does not satisfy the first real gateway milestone by itself.

### Namespace tool names as `<server>__<tool>`

Tool names from upstreams will be exposed with a deterministic prefix. Calls are decoded by splitting on the first `__`.

Alternative considered: nested server metadata inside tool annotations. MCP clients call tools by name, so routing must be recoverable from the tool name alone.

### Model upstreams as `McpServer` plus swappable transports

`McpServer` owns the server name, env injection, and transport lifecycle. `StdioTransport` owns how to create and connect an MCP SDK client.

Alternative considered: put command/url configuration directly on `McpProxy`. That would be simpler initially but would make HTTP, Docker, and per-user isolation harder to add cleanly.

### Middleware uses `req, ctx, next`

Middleware will call `next()` to continue. Returning `ctx.res.deny(...)` stops the pipeline with a tool error response. This is familiar, composable, and maps well to future policy and approval middleware.

Alternative considered: middleware returns a mutable response object by default. That is closer to the initial sketch but makes call flow less explicit and easier to accidentally bypass.

## Risks / Trade-offs

- Upstream connection failures can break `listTools` for the entire proxy -> catch per-upstream list failures later when partial availability matters; for Fase 0 fail loudly.
- Stdio child processes can remain open if sessions are not closed -> keep explicit `close()` methods and wire session transport close to proxy cleanup.
- Namespacing with `__` can conflict with server names containing the separator -> validate server names and reject invalid names at construction.
- Middleware API may need refinement once policy and approval are added -> keep types narrow and object constructors extensible.

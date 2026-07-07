## Why

Fentaris currently has a strong proxy core, but transport support is uneven: stdio upstreams are native, HTTP/HTTPS upstreams are a simplified adapter, SSE upstreams require custom code, and the proxy itself can only be exposed over HTTP. This limits Fentaris's usefulness as a governance gateway for real MCP deployments where clients and servers may require stdio, Streamable HTTP, HTTPS, or SSE.

## What Changes

- Add native upstream support for MCP Streamable HTTP over both HTTP and HTTPS.
- Add native upstream support for MCP SSE servers with full lifecycle management.
- Define a shared upstream auth model for HTTP/HTTPS/SSE transports, including custom headers, bearer tokens, API keys, and token resolver hooks.
- Preserve and document stdio upstream support for env injection, per-user secrets/tokens, and isolation behavior.
- Introduce configurable proxy exposure transports so Fentaris can serve clients over HTTP by default and also support stdio and SSE.
- Keep HTTP exposure backward-compatible with the current `McpProxy.start()` behavior.
- Avoid implementing a full OAuth authorization flow in this change; support OAuth bearer/access tokens through the shared auth model and leave token acquisition/refresh to caller-provided resolvers.

## Capabilities

### New Capabilities

- `upstream-mcp-transports`: Native MCP upstream transports for stdio, Streamable HTTP/HTTPS, and SSE, including auth and lifecycle behavior.
- `proxy-exposure-transports`: Configurable proxy exposure transports for HTTP, stdio, and SSE clients.
- `transport-auth`: Shared auth configuration and token resolution for HTTP-family MCP transports.

### Modified Capabilities

- None.

## Impact

- Affects `packages/core` public APIs for transports, proxy startup, and transport option types.
- Adds new transport classes and likely refactors `McpProxy` so request handling is decoupled from Node's HTTP server.
- May add dependencies or SDK imports for MCP Streamable HTTP client/server, SSE client/server, and stdio server transport support.
- Requires tests for upstream HTTP/HTTPS/SSE routing, downstream HTTP/stdio/SSE exposure, auth header injection, token resolution, session cleanup, and backward compatibility.
- Requires documentation updates for transport selection, auth, deployment topology, and migration from the current HTTP-only proxy exposure.

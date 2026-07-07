## 1. API Shape And Compatibility

- [x] 1.1 Audit current MCP SDK transport exports and decide exact class names for native HTTP, SSE, and proxy exposure transports
- [x] 1.2 Define upstream HTTP-family auth option types for static headers, bearer tokens, API keys, and async user-aware resolvers
- [x] 1.3 Define a downstream proxy exposure transport interface separate from `FentarisTransport`
- [x] 1.4 Refactor `McpProxy` internals so MCP SDK server creation and list/call handling can be reused outside the Node HTTP listener
- [x] 1.5 Preserve `McpProxy.start()` as the backward-compatible default HTTP exposure API

## 2. Shared Transport Auth

- [x] 2.1 Implement a helper that resolves HTTP-family outbound headers from static headers and auth options
- [x] 2.2 Support user-aware auth resolution using resolved `UserContext`, including registry-provided secrets and tokens
- [x] 2.3 Normalize missing required upstream credentials into mapped MCP errors before upstream requests are sent
- [x] 2.4 Add unit tests for headers, bearer token, API key, resolver success, and resolver failure cases

## 3. Native Upstream Transports

- [x] 3.1 Implement native MCP Streamable HTTP upstream transport for `http://` and `https://` MCP server URLs
- [x] 3.2 Add lifecycle handling for HTTP upstream initialize/session reuse and close behavior
- [x] 3.3 Implement native MCP SSE upstream transport with event-stream lifecycle and request/response correlation
- [x] 3.4 Ensure HTTP and SSE upstream transports support the shared auth resolver
- [x] 3.5 Keep or rename the current simple REST-like `HttpTransport` with clear compatibility exports and documentation
- [x] 3.6 Add tests for HTTP listTools, HTTPS callTool, SSE listTools, SSE callTool, close cleanup, and simple HTTP adapter distinction

## 4. Proxy Exposure Transports

- [x] 4.1 Extract current HTTP Streamable MCP exposure into an explicit HTTP proxy exposure transport
- [x] 4.2 Wire `McpProxy.start()` to the HTTP proxy exposure transport without changing existing defaults
- [x] 4.3 Implement stdio proxy exposure so Fentaris can run as a local MCP server process
- [x] 4.4 Implement SSE proxy exposure with session and stream cleanup
- [x] 4.5 Ensure HTTP and SSE exposure resolve downstream identity at the proxy edge
- [x] 4.6 Define and implement stdio exposure user context behavior for non-HTTP identity
- [x] 4.7 Add tests proving listTools and callTool use the same proxy pipeline across HTTP, stdio, and SSE exposure

## 5. Stdio Upstream Behavior

- [x] 5.1 Add regression tests for stdio upstream per-user env transport reuse
- [x] 5.2 Add regression tests for stdio upstream isolation queueing by user identity
- [x] 5.3 Document stdio auth as env/secrets configuration rather than protocol-level headers or OAuth

## 6. Documentation And Exports

- [x] 6.1 Export new transport classes, option types, and auth types from `packages/core/src/index.ts`
- [x] 6.2 Update transport docs with the supported upstream and downstream transport matrix
- [x] 6.3 Document HTTP-family auth examples for headers, bearer tokens, API keys, OAuth access tokens, and per-user resolvers
- [x] 6.4 Document backward compatibility and migration guidance for the existing simple HTTP adapter and `McpProxy.start()`
- [x] 6.5 Regenerate typed reference docs if required by the existing docs workflow

## 7. Verification

- [x] 7.1 Run `pnpm --filter @fentaris/core test`
- [x] 7.2 Run `pnpm --filter @fentaris/core build`
- [x] 7.3 Run repository lint/typecheck commands required by the project
- [x] 7.4 Verify `openspec status --change "mcp-transport-matrix"` reports the change as apply-ready

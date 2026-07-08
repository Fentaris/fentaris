## 1. Package Setup

- [x] 1.1 Add MCP SDK and Node runtime dependencies needed by `@fentaris/core`
- [x] 1.2 Create the `packages/core/src` module structure and public entrypoint

## 2. Transport And Upstream Core

- [x] 2.1 Implement proxied name helpers with validation
- [x] 2.2 Implement `StdioTransport` as an on-demand MCP SDK client transport
- [x] 2.3 Implement `McpServer` for upstream tool listing, tool calling, env resolution, and lifecycle close

## 3. Proxy Pipeline

- [x] 3.1 Implement `Logger`, request context, response controller, and middleware types
- [x] 3.2 Implement middleware composition with deny and continue behavior
- [x] 3.3 Implement `McpProxy` tool aggregation and namespaced call routing
- [x] 3.4 Implement streamable HTTP startup and session cleanup

## 4. Verification

- [x] 4.1 Add focused tests or a build-time verification path for helpers and middleware behavior
- [x] 4.2 Run package build and root typecheck

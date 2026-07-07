## Why

Fentaris needs a working MCP proxy core before adding policy, approvals, registries, isolation, or scaling features. A minimal passthrough core creates the stable execution path that every future governance feature will extend.

## What Changes

- Add the first `@fentaris/core` public API for creating MCP upstream servers, transports, and a proxy gateway.
- Introduce configurable object-style constructors for transports and servers.
- Support stdio MCP upstreams through `StdioTransport`.
- Expose a streamable HTTP MCP proxy endpoint that aggregates upstream tools.
- Prefix upstream tool names with a server namespace and route tool calls back to the original upstream tool.
- Add a middleware pipeline that receives every tool call before forwarding.
- Add a minimal context-aware logger and response controller for deny/continue behavior.

## Capabilities

### New Capabilities
- `mcp-proxy-core`: Core MCP proxy behavior, including upstream transports, tool aggregation, namespaced routing, middleware, context, and basic HTTP serving.

### Modified Capabilities

## Impact

- Adds source files under `packages/core/src`.
- Adds runtime dependencies on the MCP TypeScript SDK and Node typings/build tooling needed by the core package.
- Defines the initial public API exported by `@fentaris/core`.
- Does not add RBAC policies, user registries, Redis, Docker isolation, approval integrations, or autoscaling in this change.

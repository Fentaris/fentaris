## Why

Fentaris can govern and proxy tools, resources, resource templates, prompts, and completions from upstream MCP servers, but application authors do not have a first-class way to define local MCP capabilities inside the same proxy. Supporting local declarations lets Fentaris become a governed MCP application layer, not only an aggregation layer.

## What Changes

- Add a local capability declaration API for tools, resources, resource templates, prompts, and completion handlers.
- Expose declared local capabilities through the existing downstream MCP endpoint alongside upstream MCP capabilities.
- Route local capability execution through Fentaris policy, group visibility, middleware, operation routes, events, contextual logging, and audit behavior.
- Provide a clear namespace model so local capabilities do not collide with upstream server names or proxied tool/resource/prompt identifiers.
- Add type-safe handler contracts that receive the unified proxy context and can return MCP-compatible results.
- Keep existing `app.tool(...)` route semantics intact; local declarations use a distinct API to avoid confusing route middleware with capability authoring.
- Preserve custom `FentarisTransport` as an advanced escape hatch while making common local capability authoring ergonomic.

## Capabilities

### New Capabilities

- `local-capability-declarations`: Defines first-class local MCP capability authoring, listing, routing, governance, and execution behavior inside a Fentaris proxy.

### Modified Capabilities

None.

## Impact

- Affects `packages/core` public APIs around `fentaris()`, `McpProxy`, server handles, capability declaration types, context types, and exports.
- Affects proxy list/call/read/get/complete pipelines so local declarations participate consistently with upstream MCP servers.
- Affects docs for extension API, proxy setup, governance/auth, middleware, observability, and generated API reference.
- Requires tests for declaration validation, capability listing, execution, policy filtering, route/event ordering, namespace collisions, and mixed local/upstream behavior.
- Does not remove or change the current upstream `mcp(...)` registration flow, custom transport contract, or existing route APIs.

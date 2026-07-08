## Why

Fentaris currently treats upstream MCP servers as a global proxy list, then filters capabilities with policy and group governance. To support group-only MCPs, shared MCPs with group-specific behavior, and future tenant/user/runtime server attachment, the proxy needs a scoped server model instead of coupling all upstreams to one global array.

## What Changes

- Introduce a server catalog model that resolves visible MCP servers for a request context.
- Keep global `servers: [...]` as the simple default syntax for existing users.
- Add scoped MCP bindings for groups as the first public scope.
- Allow group declarations to include MCP servers as a DX shortcut, for example `group({ ..., servers: [mcp("linear", ...)] })`.
- Add fluent scoped proxy handles, for example `proxy.group("engineering").server("linear").use(...)`.
- Ensure group-scoped hooks/middleware run only when the resolved subject belongs to that group, even if the MCP server is shared with other groups.
- Defer full runtime add/remove until the catalog model is settled, but design the catalog so runtime scopes can be added later.
- Preserve current global MCP behavior for users who do not opt into scoped servers.

## Capabilities

### New Capabilities
- `scoped-mcp-server-catalog`: Context-aware MCP server catalog, group-scoped server bindings, and group-scoped proxy customization semantics.

### Modified Capabilities

## Impact

- Affects proxy server resolution, list/call routing, resource/prompt/completion listing, group declarations, and proxy scoped handle APIs.
- Requires new tests for group-only MCP visibility, shared MCP behavior, and group-scoped middleware isolation.
- May introduce internal catalog classes/types and public shortcut syntax.
- Should not introduce full runtime add/remove behavior in this change, but should avoid blocking it architecturally.

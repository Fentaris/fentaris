## Context

The proxy currently receives a global `servers: McpServer[]` list and routes list/call operations across that list. Group governance can filter capabilities after servers are queried, but the server model itself is not contextual. This makes group-only MCPs possible only as a policy/filtering convention, and it does not provide a clean foundation for tenant/user/session scoped MCP servers or future runtime attachment.

This change introduces a server catalog abstraction that resolves upstream MCP servers for a request context. Groups can declare MCP servers as a DX shortcut, but the internal model remains scoped bindings rather than making `Group` the owner of server lifecycle.

## Goals / Non-Goals

**Goals:**

- Add a context-aware server catalog used by proxy list and routing operations.
- Preserve `servers: [...]` as the global default syntax.
- Add group-scoped MCP server bindings and a `group({ servers: [...] })` DX shortcut.
- Add group-scoped proxy handles such as `proxy.group("engineering").server("linear").use(...)`.
- Ensure group-scoped hooks run only for users who belong to that group.
- Keep the model compatible with future tenant, user, session, and runtime scopes.

**Non-Goals:**

- Implement full runtime add/remove UX.
- Implement plugin contribution loading.
- Replace existing policy enforcement.
- Change proxy naming rules for tools, resources, prompts, or completions except where contextual server resolution is required.

## Decisions

### Use scoped server bindings under a catalog

The proxy will normalize server configuration into a catalog of bindings. A binding combines a `McpServer` with a scope. The first public scopes are `global` and `group`. The catalog resolves the effective server set from user, subject, group membership, and operation context.

Alternative considered: add `servers` directly to `Group` and keep the global array. That is simpler initially but couples group declarations to server lifecycle and makes tenant/user/session scopes harder later.

### Keep group server declarations as a shortcut

`group({ ..., servers: [mcp("linear", ...)] })` will be supported as ergonomic syntax. Internally this will normalize to group-scoped server bindings.

Alternative considered: require users to configure a separate catalog manually. That is cleaner internally but worse for the common DX.

### Group-scoped hooks are subject-scoped

`proxy.group("engineering").server("linear").use(...)` will run only when the resolved subject belongs to `engineering` and the operation targets `linear`. If `linear` is shared with another group, calls by users outside `engineering` must not trigger the engineering-scoped hook.

Alternative considered: scope hooks only by server name. That would be surprising and could leak group-specific behavior across shared servers.

### Global server behavior remains default

Existing `servers: [...]` configuration remains global. Users who do not opt into group-scoped servers should observe the same visibility and routing behavior as before.

Alternative considered: migrate all servers into explicit scoped declarations. That adds friction and is unnecessary for existing use cases.

### Runtime add/remove is designed for but deferred

The catalog should expose internal seams that can later support runtime add/remove, lifecycle events, and capability invalidation. The current change should not expose a public runtime mutation API until capability-change behavior is specified.

Alternative considered: add runtime mutation immediately. That would expand the scope into session consistency, cleanup, permissions, and client notification semantics before the base scoped model is proven.

## Risks / Trade-offs

- [Risk] Server resolution can diverge across tools, resources, prompts, and completions. Mitigation: route all list and target operations through the same catalog resolution helpers.
- [Risk] Shared MCP servers can accidentally trigger group-specific middleware. Mitigation: include group membership in route matching for group-scoped handles.
- [Risk] Duplicate server names across scopes can create ambiguous proxy names. Mitigation: define duplicate handling during normalization and add tests for global plus group-scoped duplicates.
- [Risk] Catalog normalization can make startup errors harder to understand. Mitigation: validate scopes, group references, duplicate names, and server names with actionable messages.

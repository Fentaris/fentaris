## 1. Catalog Model

- [x] 1.1 Define internal server scope and server binding types for global and group scopes.
- [x] 1.2 Implement a server catalog that resolves MCP servers from user, subject, group membership, and operation context.
- [x] 1.3 Preserve current global `servers: [...]` behavior by normalizing it into global catalog bindings.
- [x] 1.4 Add validation for duplicate names, missing group references, and ambiguous global/group scoped bindings.

## 2. Group Declaration DX

- [x] 2.1 Extend group declaration options to accept a `servers` shortcut.
- [x] 2.2 Normalize group-declared servers into group-scoped catalog bindings without changing existing group policy, users, credentials, or metadata behavior.
- [x] 2.3 Export any new public types needed for group-scoped server declarations.

## 3. Proxy Routing Integration

- [x] 3.1 Replace direct global server iteration in tool listing with catalog resolution.
- [x] 3.2 Replace direct global server iteration in resource, resource-template, and prompt listing with catalog resolution.
- [x] 3.3 Ensure tool calls, resource reads, prompt gets, and completions can route to catalog-resolved servers.
- [x] 3.4 Keep existing proxy naming behavior stable for global servers.

## 4. Group-Scoped Handles

- [x] 4.1 Add `proxy.group(groupId)` as a scoped proxy handle.
- [x] 4.2 Add `proxy.group(groupId).server(serverName).use(...)` for group-and-server scoped middleware.
- [x] 4.3 Add group-scoped tool, operation, and event registration if they fit the existing proxy handle pattern.
- [x] 4.4 Ensure group-scoped handlers match resolved subject membership, not only server name.

## 5. Tests

- [x] 5.1 Test that a group-scoped MCP server appears only for users in that group.
- [x] 5.2 Test that non-members cannot call a group-scoped MCP server.
- [x] 5.3 Test that shared MCP servers do not trigger another group's scoped middleware.
- [x] 5.4 Test that global servers remain visible and callable as before.
- [x] 5.5 Test duplicate and ambiguous binding validation.

## 6. Verification

- [x] 6.1 Run focused proxy and governance tests.
- [x] 6.2 Run `@fentaris/core` tests.
- [x] 6.3 Run `@fentaris/core` build.

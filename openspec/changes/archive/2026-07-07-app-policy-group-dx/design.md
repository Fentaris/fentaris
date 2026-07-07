## Context

`fentaris(...)` currently supports config-first governance through `policy(...)`, `group(...)`, and constructor options. The proxy also supports fluent app composition through `app.mcp(...)`, including registering upstream MCP servers after construction while deferring policy server visibility validation until start or in-process operations.

The desired API extends that fluent composition model to governance:

```ts
app.policy("readonly")
  .mcp("github")
  .allow("read");

app.policy("maintainers")
  .mcp("github")
  .allow("*");

app.group("guests")
  .users(user("guest"))
  .policy("readonly");

app.group("maintainers")
  .users(user("alice"), user("bob"))
  .policy("maintainers");
```

This should coexist with existing config-first declarations and should not make a policy responsible for user membership. Policies continue to describe allowed actions; groups continue to bind users to policies.

## Goals / Non-Goals

**Goals:**

- Add `app.policy(name)` as the app-level fluent entry point for named policies.
- Add a group builder that can declare users and attach a named or concrete policy after construction.
- Keep `policy(...)`, `group(...)`, and `fentaris({ policy, groups })` fully supported.
- Reuse existing policy evaluation, group evaluation, subject indexing, and configuration validation behavior where possible.
- Ensure missing named policies and invalid group declarations produce Fentaris configuration diagnostics.

**Non-Goals:**

- Do not move users into policy declarations.
- Do not introduce a new authorization model beyond the existing policy and group semantics.
- Do not remove constructor-time governance configuration.
- Do not add persistent storage or dynamic runtime mutation after the proxy has started.

## Decisions

### Use an internal named policy registry

`McpProxy` will maintain an app-level map of named `Policy` instances declared through `app.policy(name)`. Calling `app.policy("readonly")` returns the existing policy if it has already been declared, or creates and registers a new `Policy` instance if not.

Alternative considered: make `app.policy(name)` only return `policy(name)`. That would be simpler, but it would not support string references from `app.group(...).policy("readonly")` and would not provide meaningful app-level composition.

### Keep group membership separate from policy declarations

`app.group("guests").users(...).policy("readonly")` binds users to a policy, while `app.policy("readonly")` remains purely about permissions. This preserves the current governance model and keeps policies reusable across multiple groups.

Alternative considered: allow `.users(...)` on policy builders. That makes the fluent chain shorter for small apps, but it couples identity membership to authorization rules and makes policy reuse harder.

### Extend group handles rather than replacing config groups

`app.group(id)` currently returns a scoped routing handle for an existing configured group. This change will extend group handling so a missing group can be declared before start through a governance-capable group handle. Existing route-scoped behavior remains available from the same handle.

The group handle will support:

- `.users(...users)`
- `.policy(policyName | Policy)`
- existing `.mcp(...)`, `.use(...)`, `.operation(...)`, and `.on(...)` routing APIs

Alternative considered: introduce `app.governance.group(id)` to avoid overloading `app.group(id)`. That avoids ambiguity but weakens the symmetry with `app.mcp(...)` and creates another namespace for common app composition.

### Resolve string policy references during config validation

Named policy references from fluent groups will resolve before validation completes. If a group references a missing policy name, validation will report a configuration error. Existing concrete policy objects continue to work unchanged.

Alternative considered: resolve string policy references lazily during each request. That would complicate policy evaluation and defer a configuration problem into request handling.

### Rebuild derived governance indexes after fluent declarations

Because groups can be added after construction, the proxy must keep derived structures such as group lists, subject indexes, and server catalogs coherent before start and before in-process operations. The implementation should centralize this refresh so `app.mcp(...)`, `app.policy(...)`, and `app.group(...)` all feed the same validation/runtime view.

Alternative considered: require all fluent declarations before the first call and throw after any runtime method is used. This is simpler but brittle; the existing `app.mcp(...)` deferred behavior already expects final validation at start or operation time.

## Risks / Trade-offs

- Duplicate meanings for `app.group(id)` -> Keep the handle backward-compatible and make declaration methods additive.
- Policy name conflicts between constructor groups and app policies -> Validate duplicate or ambiguous declarations explicitly.
- Derived governance state becoming stale -> Centralize config resolution before validation and runtime operations.
- Public API surface grows -> Cover with runtime tests, type contract tests, docs, and generated API reference.

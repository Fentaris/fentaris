## 1. API Contracts

- [x] 1.1 Extend public proxy types with `app.policy(name)` returning the fluent policy builder.
- [x] 1.2 Extend group handle types with `.users(...users)` and `.policy(policyNameOrPolicy)` while preserving existing routing methods.
- [x] 1.3 Add type contract tests for the target fluent API example and existing config-first governance declarations.

## 2. Runtime Implementation

- [x] 2.1 Add an internal named policy registry to `McpProxy`.
- [x] 2.2 Implement `app.policy(name)` so repeated calls return the same named policy instance.
- [x] 2.3 Extend `app.group(id)` to create or retrieve fluent group declarations before start.
- [x] 2.4 Implement group `.users(...)` accumulation with existing `User` objects.
- [x] 2.5 Implement group `.policy(...)` for both named policy references and concrete policy instances.
- [x] 2.6 Ensure derived governance state, subject indexes, and server catalogs include fluent groups and policies before validation and runtime operations.

## 3. Validation

- [x] 3.1 Add diagnostics for fluent groups that reference missing named policies.
- [x] 3.2 Add diagnostics for empty fluent groups.
- [x] 3.3 Add diagnostics for duplicate or ambiguous group and policy declarations.
- [x] 3.4 Verify deferred MCP server validation still accepts policies before `app.mcp(...)` and fails before serving if the server remains missing.

## 4. Runtime Tests

- [x] 4.1 Test the readonly and maintainers fluent API example end to end.
- [x] 4.2 Test repeated `app.policy("readonly")` calls compose onto the same policy.
- [x] 4.3 Test repeated `.users(...)` calls append users to the same group.
- [x] 4.4 Test mixed constructor groups and fluent groups are evaluated together.
- [x] 4.5 Test missing named policy, empty fluent group, duplicate declarations, and unresolved MCP server diagnostics.

## 5. Documentation

- [x] 5.1 Update governance/security docs with the app-level policy and group composition example.
- [x] 5.2 Update proxy setup docs to show `app.policy(...)`, `app.group(...)`, and `app.mcp(...)` working together.
- [x] 5.3 Regenerate API reference if public API documentation is generated from source.

## 6. Verification

- [x] 6.1 Run `pnpm --filter @fentaris/core test`.
- [x] 6.2 Run `pnpm --filter @fentaris/core build`.
- [x] 6.3 Run `pnpm docs:generate` if public API docs changed.

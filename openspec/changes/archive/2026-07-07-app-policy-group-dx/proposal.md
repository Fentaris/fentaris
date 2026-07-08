## Why

Fentaris already supports fluent upstream registration with `app.mcp(...)`, but governance configuration still requires mixing standalone policy builders with constructor-time group declarations. A matching app-level governance API would make incremental app composition more coherent while preserving the existing config-first style.

## What Changes

- Add an app-level policy declaration API:
  - `app.policy("readonly").mcp("github").allow("read")`
  - `app.policy("maintainers").mcp("github").allow("*")`
- Add an app-level group declaration API that can attach users and named policies fluently:
  - `app.group("guests").users(user("guest")).policy("readonly")`
  - `app.group("maintainers").users(user("alice"), user("bob")).policy("maintainers")`
- Resolve named group policies against policies declared with `app.policy(...)`.
- Preserve existing `fentaris({ policy, groups })`, `policy(...)`, and `group(...)` configuration paths.
- Validate missing policy names, duplicate declarations, empty groups, and server visibility with the existing configuration diagnostic model.

## Capabilities

### New Capabilities
- `app-governance-dx`: App-level fluent policy and group declaration APIs for composing governance alongside app-level MCP server registration.

### Modified Capabilities
- `core-domain-architecture`: Public API compatibility must cover the new app-level governance API without requiring subpath imports.

## Impact

- Affects `@fentaris/core` public proxy API and type contracts.
- Affects governance config resolution and validation.
- Adds runtime and type-level tests for `app.policy(...)`, fluent group membership, named policy references, and interoperability with existing config-first declarations.
- Updates docs and generated API reference for the new governance composition style.

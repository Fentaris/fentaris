## Why

Fentaris's current governance primitives work, but the developer experience is still too manual: users, groups, policy, credentials, and upstream auth are scattered across `UserContext`, registry secrets, middleware, and transport env/header wiring. Fentaris needs an Express-like governance API where developers declare users and groups in TypeScript, keep secrets encrypted, and let Fentaris resolve policy and upstream auth automatically.

## What Changes

- Add first-class `User`, `Group`, and `Policy` DX APIs for declaring subjects and group-owned policies in code.
- Make `Group` the owner of user membership and policy assignment; `McpProxy` receives groups rather than a separate users list.
- Add API-key identity resolution where callers authenticate with a secret key, not a spoofable user id header.
- Add unified `FentarisAuth.local(...)` / encrypted auth configuration that hides the linked local files from application code.
- Store sensitive user/group/default credentials and user API keys in encrypted local JSON.
- Store non-sensitive upstream auth bindings in a separate local JSON file managed through the unified auth object.
- Automatically resolve upstream auth per request from user credentials, group credentials, and defaults using a deterministic precedence order.
- Keep policy declarations in TypeScript rather than JSON, with fluent helpers for allow/deny, limits, approvals, and sensitive operations.
- Expose resolved subject context to middleware/hooks without exposing raw secrets.

## Capabilities

### New Capabilities

- `subject-groups`: TypeScript-first `User` and `Group` declarations where groups own membership and policy.
- `policy-dx`: Express-like `Policy` API with fluent allow/deny, limiter, approval, and metadata helpers.
- `local-auth-store`: Unified local auth configuration backed by encrypted credentials and non-sensitive upstream auth bindings.
- `api-key-identity`: Secure API-key-based caller authentication that resolves to a declared user subject.
- `credential-resolution`: Automatic user/group/default credential lookup and upstream auth injection without application code accessing raw secrets.
- `governance-context`: Middleware and hook context exposing subject, groups, policy, and credential metadata without leaking secret values.

### Modified Capabilities

- None.

## Impact

- Affects `packages/core` public governance APIs, identity resolution, policy types, registry/credential abstractions, and middleware context shape.
- Adds encrypted local credential storage and likely CLI/docs helpers for initializing and setting secrets.
- Adds local upstream auth binding parsing and validation.
- Requires tests for group membership, API-key authentication, credential precedence, upstream auth binding, policy evaluation, middleware context, and secret redaction.
- Requires documentation showing the recommended DX with `FentarisAuth.local`, `user`, `group`, `policy`, `mcp.*`, and `proxy.use`.

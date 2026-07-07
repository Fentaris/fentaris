## Context

Fentaris currently has governance building blocks: `UserContext`, identity strategies, registry secrets/tokens, `SimplePolicy`, `ToolPermission`, rate limit middleware, and approval callbacks. The pieces are functional but not cohesive for a developer building a production proxy. Users and groups are not first-class, policy is global rather than group-owned, API-key identity is not modeled as the default secure local pattern, and upstream auth currently relies on manual `env(user)` or header wiring.

This change introduces a higher-level governance and auth DX. Developers declare `User`, `Group`, and `Policy` in TypeScript. Sensitive credentials and user API keys live in encrypted local JSON. Non-sensitive upstream auth bindings live in local JSON. `FentarisAuth.local(...)` hides those files behind one object, and `McpProxy` receives groups, auth, and servers.

## Goals / Non-Goals

**Goals:**

- Provide first-class `User`, `Group`, and `Policy` APIs with an Express-like developer experience.
- Make groups own users and policy; `McpProxy` should not need a separate users list.
- Authenticate callers with API keys or equivalent secret tokens rather than spoofable user id headers.
- Resolve the authenticated caller into a declared subject and group memberships.
- Keep policies in TypeScript and keep secrets out of application code.
- Resolve upstream credentials automatically using user > group > default precedence.
- Apply upstream auth bindings automatically when transports call remote MCP servers.
- Expose a safe governance context to middleware and hooks without raw secret values.

**Non-Goals:**

- Do not move policy declarations into JSON.
- Do not implement OAuth acquisition, consent, discovery, or refresh flows.
- Do not expose raw decrypted secrets to normal middleware context.
- Do not require external secret managers for the local DX.
- Do not remove existing lower-level governance APIs immediately.

## Decisions

### Keep subjects and policy in TypeScript

`User`, `Group`, and `Policy` will be declared in code. This keeps policy expressive, testable, and composable with TypeScript functions such as approval callbacks and custom limiters.

Alternative considered: store users, groups, and policies in JSON. This is easier to serialize but becomes hard to read once approvals, rate limit functions, and dynamic policy behavior are needed.

### Let groups own users

`Group` declarations include their users and policy. `McpProxy` receives `groups: Group[]` and builds the internal subject index from those groups. A user can appear in multiple groups, and effective permissions are computed from those memberships.

Alternative considered: pass `users` and `groups` separately to `McpProxy`. This creates duplicated ownership and makes it easier to accidentally register a user without a group or a group without valid users.

### Use API keys as the default secure identity pattern

The default local identity strategy will read a configured header such as `x-fentaris-api-key`, hash or compare the key securely, and resolve it to a declared user id from encrypted auth storage. User id headers can remain available for trusted internal setups but are not the recommended secure default.

Alternative considered: keep `x-user-id` as the primary identity mechanism. That is acceptable behind a trusted auth gateway but unsafe as a direct Fentaris auth mode.

### Unify local auth configuration

Expose a single `FentarisAuth.local({ dir, key })` or equivalent API. Internally it reads encrypted secrets and non-sensitive upstream auth bindings from predictable files, but application code treats auth as one object.

Alternative considered: require developers to pass separate `credentials` and `upstreamAuth` objects. That is explicit but makes two linked files feel unrelated and harder to onboard.

### Separate credential values from upstream auth bindings

Encrypted credentials store secret values and API keys. Upstream auth bindings store non-sensitive instructions such as `github -> bearer github.apiKey`. This lets developers change auth wiring without editing encrypted content, while keeping values protected.

Alternative considered: store auth bindings inside encrypted JSON. That reduces file count but makes non-sensitive configuration harder to review and version.

### Prefer fluent helpers with class-backed entities

The API can offer `new User`, `new Group`, and `new Policy`, plus shorter helpers such as `user()`, `group()`, `policy()`, `allow()`, `deny()`, `limit()`, and `approval.*`. The class-backed model remains stable while helpers improve readability.

Alternative considered: pure classes only. That is familiar but can become verbose for policy declarations.

### Do not expose raw secrets in governance context

Middleware and hooks receive `ctx.subject`, group names, policy information, and credential source metadata, not decrypted credential values. Upstream transports receive resolved auth through a controlled internal path.

Alternative considered: attach decrypted secrets to `ctx.subject`. That recreates the current `user.secrets` problem and increases accidental logging risk.

## Risks / Trade-offs

- Encrypted local files can create key-management confusion -> Provide clear `FentarisAuth.local` defaults, validation errors, and CLI helpers.
- Multiple group membership can create ambiguous policy behavior -> Define deterministic policy merge semantics and test conflicts.
- API keys stored in encrypted files still need rotation -> Support multiple keys per user and key identifiers where possible.
- Hiding two files behind one auth object can obscure how auth works -> Document the internal file layout and provide inspect commands that redact secrets.
- Backward compatibility with `SimplePolicy` and existing `UserContext` can complicate context shape -> Add compatibility adapters and deprecate gradually rather than breaking existing users.

## Migration Plan

1. Add new User/Group/Policy DX APIs without removing current `SimplePolicy`.
2. Add `FentarisAuth.local` and encrypted local store support.
3. Add API-key identity resolution and subject index resolution from groups.
4. Add credential resolution and upstream auth binding support.
5. Wire the new governance context into middleware/hooks while preserving `ctx.user` compatibility where practical.
6. Update docs to recommend the new DX and mark direct `user.secrets` access as an advanced/legacy path.

## Open Questions

- Should effective policy across multiple groups be union-based with explicit deny precedence, or first-match by group order?
- Should `User` ids be arbitrary strings, or should Fentaris enforce a restricted id format?
- Should encrypted local files use a passphrase-derived key or require a raw encryption key from environment variables?

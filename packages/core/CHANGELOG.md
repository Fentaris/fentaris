# @fentaris/core

## 2.3.1

### Patch Changes

- 569938f: Avoid cloud discovery fallback for policy-hidden edge MCP servers during `tools/list`. Exact tool allows now win over a companion `*` deny in both discovery pre-filtering and group tool listing, matching call-time policy evaluation.

## 2.3.0

### Minor Changes

- e46a7ba: Add agent-native MCP tool discovery and auth inspection. Core now validates `cli.mcpAccounts` selectors and exposes `AgentToolDiscoveryService` with stable JSON envelopes, policy-filtered effective tool listing, search, detail, schema inspection, account status, login affordances, pagination, and response budgeting. The CLI adds `fentaris tools list/search/get/schema` and `fentaris tools auth list/status/login`.

### Patch Changes

- e39be45: Expose the typed Edge setup builders on the public `edge` namespace and preserve each setup descriptor's discriminated field type.
- b81f061: Return `requires-login` for agent tool auth status when an MCP server declares credential requirements.

## 2.2.0

### Minor Changes

- f355a29: Add governed edge execution targets, including device enrollment, local setup grants, session-pinned dispatch, capability discovery, and the edge workload runtime.

## 2.1.2

### Patch Changes

- f46bdad: Accept user- and group-scoped credential sources when validating upstream MCP server credential references.

## 2.1.1

### Patch Changes

- e889b9d: Add a JSON stdout logger factory for structured Fentaris runtime logs.
- 40c6e9a: Give two-argument middleware callbacks contextual `ctx` and `next` types in strict TypeScript.

## 2.1.0

### Minor Changes

- 3874e97: Add `fentaris auth api-key` commands for storing, listing, generating, and removing local downstream API keys, with hashed API-key management helpers on the local secrets backend.
- bde0b12: Add `app.local(name)` for declaring local MCP tools, resources, resource templates, prompts, and completions through the existing proxy governance pipeline. Local namespaces now consistently reject same-name upstream MCP registrations regardless of declaration order.

### Patch Changes

- 5a319c2: Add `app.server(...)` as a top-level alias for registering and retrieving upstream MCP server handles.

## 2.0.0

### Major Changes

- ef570e8: Rename remaining legacy configuration and secrets provider identifiers to Fentaris.

## 1.0.0

### Major Changes

- 05425ab: Harden proxy policy enforcement by denying unconfigured proxy access by default, making policy denies terminal before hooks or middleware, re-filtering tool discovery after hooks, enforcing policy-attached rate limiters automatically, and reporting open-policy CLI diagnostics.

### Minor Changes

- f4af3c4: Harden runtime security primitives by routing declared API key checks through the shared timing-safe comparison helper, enforcing rate limits through atomic consume operations, and redacting token-like values before logger and profiler sink dispatch.
- 190f600: Add native MCP Streamable HTTP and SSE upstream transports, configurable HTTP/stdio/SSE proxy exposure transports, and shared HTTP-family upstream auth helpers.
- 06c68bf: Add the group-scoped `server(name)` proxy handle alias for scoped MCP server middleware, routes, and events.

### Patch Changes

- e81b53e: Harden local secrets handling with stdin secret input, truthful unset reporting, versioned PBKDF2 credential storage, owner-only credential file permissions, and improved manifest diagnostics.
- bb4b69c: Harden downstream transport authentication and upstream HTTP networking defaults.

  HTTP Streamable and SSE exposure transports now bind session continuations to the authenticated identity, SSE `/messages` requests resolve identity before accepting posts, stdio exposure fails when identity is required but unavailable, and HTTP/SSE listeners bind to `127.0.0.1` unless a host is configured. Upstream HTTP transports now avoid arbitrary env-to-header forwarding and block loopback, link-local, private, and metadata URLs unless explicitly allowed.

- 0ee5a94: Emit structured `profiler.sink.error` events when profiler sink failures are isolated and redact token-shaped profiler values by default.

## 0.7.0

### Minor Changes

- 8a5a563: Add `app.usePolicy(...)` for applying named or concrete policies as the global proxy policy after construction.

## 0.6.2

### Patch Changes

- e308af0: Load runtime port and path defaults from the nearest project `fentaris.json` when starting an app without explicit options.

## 0.6.1

### Patch Changes

- 97ed1cb: Load runtime port and path defaults from the nearest project `fentaris.json` when starting an app without explicit options.

## 0.6.0

### Minor Changes

- 2a952cf: Add app-level fluent governance declarations with `app.policy(...)`, `app.group(...).users(...)`, and named group policy assignment.
- c8023e5: Add cloud-ready local secrets management with a `SecretsBackend` abstraction, `fentaris secrets list`, `manifest`, `doctor`, and `unset` commands, plus a committable `.fentaris/secrets.manifest.json` schema.

### Patch Changes

- 8e20832: Fix secrets manifest generation and local secrets presence checks.

  Generated projects now allow `.fentaris/secrets.manifest.json` to be committed while keeping local secret files ignored, and `fentaris secrets manifest` creates the auth directory before writing the manifest. The local secrets backend no longer reports arbitrary user-scoped credentials as present when a user only has API keys.

## 0.5.1

### Patch Changes

- 192dd8b: Allow policies to reference upstream MCP servers registered later through `app.mcp(...)`, with final policy server visibility validation deferred until startup.

## 0.5.0

### Minor Changes

- ced04e2: Improve the generated project and runtime DX: `fentaris()` now picks up local project defaults, deferred MCP declarations can satisfy policy validation before start, scoped middleware receives contextual types, and a concise `rateLimit({ max, per })` helper is available.

  `fentaris dev` now runs the configured entrypoint directly, loads `.env`, and forwards termination signals to the child process.

## 0.4.0

### Minor Changes

- ab74382: Add approval decision helpers on middleware context and enrich tool approval requests with operation metadata while preserving tool names, proxy names, arguments, and raw MCP params.
- f2d29f2: Expose placeholder plugin contracts from `@fentaris/core/experimental/plugins` and document that plugin support is experimental and not runtime-ready.
- 683ae94: Add runtime lifecycle and health APIs with typed health checks, lifecycle state inspection, timeout handling, built-in health reports, and profiler events.

### Patch Changes

- fa23cad: Fix runtime lifecycle cleanup, repeated explicit exposure registration, and recovered health readiness transitions.

## 0.3.0

### Minor Changes

- be8e9e1: Add TypeScript-first config validation APIs, structured diagnostics, diagnostic renderers, and automatic high-level startup validation.

### Patch Changes

- a2cd723: Add the runtime profiler API, typed runtime events, structured runtime errors, redacted sink dispatch, and automatic proxy instrumentation.

## 0.2.0

### Minor Changes

- de87ca4: Add the public `@fentaris/core/extensions` entrypoint for extension contract types and document supported API tiers for framework users.
- 94bfaf9: Add a scoped MCP server catalog with group-scoped server declarations and group-scoped proxy handles.

## 0.1.1

### Patch Changes

- 1a37457: Fix the exported plugin context type so lint passes cleanly in release CI.

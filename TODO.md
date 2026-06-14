# TODO

## Alpha Hardening

Goal: stabilize the public surface before publishing the alpha. Do not add broad
new features here unless they remove ambiguity from an API that is already
public.

### 1. Context API

- Decide the canonical middleware/context API for alpha.
- Review `ProxyContext` naming and shape:
  - `operation`
  - `transport`
  - `auth`
  - `policy`
  - `credentials`
  - `server`
  - `tool`
  - `resource`
  - `prompt`
  - `completion`
  - `args`
  - `raw`
  - `state`
- Decide what should be canonical between:
  - `ctx.response`
  - `ctx.res`
  - `ctx.deny(...)`
  - `ctx.fail(...)`
  - `ctx.error(...)`
  - `ctx.continue()`
  - `ctx.inject(...)`
- Decide how much of `MiddlewareContext`, legacy `call` hooks, and
  `ResponseController` should remain documented for alpha.
- Make docs and examples consistently use the canonical API.
- Verify context contents for every governed MCP operation:
  - `tools:list`
  - `tool:call`
  - `resources:list`
  - `resource:read`
  - `resource-templates:list`
  - `prompts:list`
  - `prompt:get`
  - `completion:complete`
- Verify that safe metadata is exposed and secrets are never exposed through
  context, logs, policy decisions, or errors.

### 2. High-Level API And Naming

- Review the high-level API for creating a proxy and declaring upstream MCP
  servers.
- Make the naming model obvious:
  - `fentaris(...)` creates the proxy.
  - `server(...)` or `mcp(...)` declares an upstream MCP server.
  - transport helpers declare how Fentaris connects to that upstream.
- Decide final names for upstream transport helpers before alpha:
  - `stdio(...)`
  - `streamableHttp(...)`
  - `SseMcpTransport` / possible helper naming
  - `HttpTransport` / legacy or low-level positioning
- Clarify the difference between upstream transports and downstream exposure
  transports:
  - upstream: how Fentaris connects to MCP servers;
  - downstream: how clients connect to Fentaris.
- Decide which APIs are stable for alpha and which are advanced or
  experimental.
- Review public exports in `@fentaris/core` and avoid presenting low-level
  internals as equally stable first-class APIs.

### 3. Approval

- Review custom approval callbacks and manual approval workflows.
- Verify approval handlers receive the correct request shape for both direct
  tool permissions and capability permissions.
- Verify tool approval callbacks preserve:
  - server name;
  - tool name;
  - proxy tool name;
  - arguments;
  - raw MCP params.
- Verify manual approval metadata is safe and useful:
  - status;
  - reason;
  - request id;
  - URL;
  - custom metadata.
- Verify pending approvals deny the current call with a clear structured error.
- Verify Telegram approval remains documented as an adapter, not as the approval
  system itself.
- Defer bigger approval UX/product decisions to a dedicated follow-up.

### 4. Plugins

- Keep plugins minimal for alpha.
- Mark the plugin system as experimental.
- Make it clear that plugin support is mostly placeholder and not production
  ready.
- Document what currently exists:
  - manifest types;
  - registry contract;
  - loader contract;
  - lifecycle hook contract;
  - capability metadata placeholder.
- Document what does not exist yet:
  - real loading flow;
  - package discovery;
  - activation runtime;
  - permission negotiation;
  - plugin-auth integration;
  - CLI plugin management.
- Consider moving plugin exports behind an experimental subpath if the main API
  feels too crowded.

### 5. Doctor CLI

- Expand `fentaris doctor` beyond basic environment checks.
- Add project discovery checks:
  - project root;
  - `fentaris.json`;
  - configured entrypoint;
  - auth directory;
  - expected generated files.
- Add config validation:
  - parse `fentaris.json`;
  - validate port and path;
  - validate entrypoint path;
  - validate package manager;
  - surface actionable diagnostics.
- Add dependency checks:
  - `@fentaris/core` dependency;
  - package scripts;
  - TypeScript config;
  - package manager lockfile where appropriate.
- Add auth checks:
  - local auth directory exists;
  - encrypted credentials file exists when expected;
  - auth key environment hints are clear;
  - never print secrets.
- Add runtime/network checks:
  - configured port availability;
  - endpoint path shape;
  - optional health endpoint or runtime health integration when available.
- Improve `--fix` so it only performs safe, explicit repairs.
- Improve output grouping so users can distinguish failures, warnings, and
  optional recommendations.
- Keep `fentaris check` and `fentaris doctor` responsibilities clear.

### 6. Documentation

- Rebuild docs around a scalable information architecture.
- Keep the first path simple:
  - install;
  - create a proxy;
  - add upstream MCP servers;
  - add policy;
  - run and connect a client.
- Separate docs into clear layers:
  - getting started;
  - core concepts;
  - guides;
  - CLI;
  - security/auth/approval;
  - API reference;
  - experimental APIs.
- Create a dedicated documentation skill/agent workflow before the full rewrite.
- Define documentation style rules:
  - consistent examples;
  - copy-paste runnable snippets;
  - clear naming;
  - no stale APIs;
  - alpha/experimental labels where needed.
- Keep generated API reference separate from narrative docs.
- Add examples that explain upstream transport naming and downstream exposure
  naming without mixing the two.

### 7. Release Hygiene

- Finish Panther-to-Fentaris naming cleanup where it affects public docs,
  package names, badges, examples, and commands.
- Review package metadata before publish:
  - package names;
  - versions;
  - repository URLs;
  - homepage;
  - keywords;
  - files list;
  - license.
- Review public exports and generated declarations.
- Run focused package tests and build checks before publishing.
- Archive or clean up completed OpenSpec changes so release state is readable.
- Prepare changelogs and changesets intentionally.

## Later: Runtime Resilience And Limits

This is useful, but it should not expand alpha scope unless it blocks safe
usage.

- Timeout enforcement for runtime operations and MCP calls.
- Cancellation and abort signal propagation.
- Concurrency limits for MCP calls and runtime operations.
- Queue mode versus reject mode when concurrency is saturated.
- Maximum tool result size.
- Maximum request/body size where applicable.
- Prudent retry policy:
  - safe by default for connect/startup/list operations where appropriate;
  - opt-in for MCP tool calls because tool calls can have side effects.
- Basic circuit breaker, likely after lifecycle/health state is stable.
- Fallback server behavior as a later or experimental feature.
- Profiler events for timeout, cancellation, limit exceeded, retry
  scheduled/exhausted, circuit opened/closed, and request rejected.

Important architectural dependency:

- This plan should build on lifecycle/health state instead of inventing its own
  component status model.
- Resilience should apply countermeasures; profiler should observe and log what
  happened.

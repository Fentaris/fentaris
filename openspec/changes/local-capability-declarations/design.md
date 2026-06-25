## Context

Fentaris currently treats MCP capabilities as coming from configured upstream `McpServer` instances. The proxy can list and route tools, resources, resource templates, prompts, and completions from those upstreams, and the governance layer already applies policy, middleware, events, contextual logging, and audit metadata across those operations.

Application authors can define local behavior today only by implementing a custom `FentarisTransport` and mounting it with `app.mcp(...)`. That escape hatch is powerful, but it is too low-level for common use cases such as adding a small computed tool, exposing an app-owned resource, or publishing prompt templates from the same Fentaris project.

## Goals / Non-Goals

**Goals:**

- Add a first-class local capability declaration API for tools, resources, resource templates, prompts, and completion handlers.
- Keep local capability execution inside the existing proxy governance pipeline.
- Give local capabilities stable names and URIs that compose with upstream namespacing, group-scoped servers, and policy declarations.
- Provide typed handler contracts that receive the unified `ProxyContext` and operation parameters.
- Support modular app composition where different modules can contribute declarations before startup.
- Preserve existing `app.tool(...)` route semantics and existing custom transport support.

**Non-Goals:**

- Do not implement a plugin runtime or package discovery flow.
- Do not replace `FentarisTransport` for advanced integrations.
- Do not introduce a new downstream protocol beyond MCP.
- Do not support resource subscriptions or list-change notifications in this change.
- Do not allow local declarations to bypass policy or middleware.
- Do not rename existing proxied upstream tool, prompt, resource, or template identifiers.

## Decisions

### Use `app.local(name)` as the declaration boundary

Fentaris will expose local declarations through a distinct API such as:

```ts
const local = app.local("workspace");

local.tool("status", { inputSchema }, async (ctx) => {
  return { content: [{ type: "text", text: "ok" }] };
});

local.resource("config://current", { name: "Current config" }, async (ctx) => {
  return { contents: [{ uri: ctx.resource?.uri ?? "config://current", text: "{}" }] };
});

local.prompt("review_pr", { arguments: [{ name: "diff" }] }, async (ctx, params) => {
  return { messages: [{ role: "user", content: { type: "text", text: String(params.arguments?.diff ?? "") } }] };
});
```

Alternative considered: overload `app.tool("name", ...)` for authoring. That conflicts with the current route API, where `app.tool(...)` registers middleware for existing proxied tools. A separate `local(...)` boundary keeps route behavior and capability authoring clear.

### Model local declarations as an internal server binding

Each `app.local(name)` declaration will materialize as an internal Fentaris-owned server in the same catalog used by upstream MCP servers. The proxy pipelines should see local capabilities through the existing server resolution path, with a transport-like adapter that implements `FentarisTransport` from declarations.

Alternative considered: add separate local arrays to every list/call/read/get/complete method. That would duplicate routing and policy logic, and it would increase the chance that local capabilities diverge from upstream behavior.

### Reuse existing namespacing rules

Local tools and prompts will be exposed with the same public proxied naming rules used for upstream servers, such as `workspace__status` and `workspace__review_pr`. Local resources and resource templates will use existing Fentaris proxy URI helpers with `workspace` as the server name.

Alternative considered: expose local tools without a server prefix. That is convenient for tiny apps, but it creates collision risk and makes policy, routing, events, and audit records less consistent.

### Keep policy declarations server-oriented

Policies will authorize local declarations through the existing `.mcp(name)` server namespace. For example, `policy("dev").mcp("workspace").allow("status")` grants access to the local `workspace` tool. Capability permissions for resources, prompts, templates, and completions reuse the generalized operation model.

Alternative considered: add a separate `.local(name)` policy builder. That reads nicely but duplicates the underlying MCP server namespace and complicates mixed local/upstream group configuration.

### Use typed declaration metadata plus MCP-compatible handlers

Declaration APIs will accept MCP-shaped metadata and typed handlers:

- `tool(name, metadata, handler)` contributes to `tools/list` and handles `tools/call`.
- `resource(uri, metadata, handler)` contributes to `resources/list` and handles exact `resources/read`.
- `resourceTemplate(uriTemplate, metadata, handler)` contributes to `resources/templates/list` and handles matching template reads when a concrete URI is routed to the template.
- `prompt(name, metadata, handler)` contributes to `prompts/list` and handles `prompts/get`.
- `completion(refMatcher, handler)` handles `completion/complete` for declared prompts or resource templates.

Alternative considered: require handlers to return only raw strings and let Fentaris wrap them. That lowers the first example cost but loses MCP expressiveness for structured content, embedded resources, prompt messages, and completion values.

### Validate declarations before serving

Fentaris will reject duplicate local names, duplicate local resource URIs, invalid names, invalid URI templates, missing schemas where required, and collisions with configured upstream server names. Validation should run during registration when possible and again during startup with existing configuration diagnostics.

Alternative considered: allow later declarations to overwrite earlier ones. That makes module composition brittle because import order silently changes the exposed MCP surface.

### Local handlers receive governed context

Handlers will receive the same unified context shape used by middleware and operation routes, including subject, operation, server, tool/resource/prompt/completion metadata, logger, state, and response helpers. Local execution must emit the same operation events and logs as upstream execution.

Alternative considered: give local handlers a smaller context with only params and logger. That is simpler, but local capabilities are often app-specific and need subject, policy, auth, request state, and audit-safe logging.

## Risks / Trade-offs

- [Risk] The API can become too broad in one change -> Mitigation: ship the core declaration surface first and leave subscriptions, notifications, and plugin packaging for later.
- [Risk] `app.local(name)` might be confused with local-only transport configuration -> Mitigation: document it as an MCP capability namespace and show it alongside `app.mcp(...)`.
- [Risk] Resource template matching can be subtle -> Mitigation: centralize URI template matching and add exact/template precedence tests.
- [Risk] Local handlers could accidentally skip governance if wired outside the catalog -> Mitigation: implement them through an internal server/transport adapter and test policy denial before handler invocation.
- [Risk] Completion routing can be ambiguous when multiple handlers match -> Mitigation: require completion handlers to bind to a declared prompt or resource template and validate duplicate handlers.

## Migration Plan

1. Add local declaration types and an internal declared-capability transport adapter.
2. Add `app.local(name)` and a `ProxyLocalHandle` while leaving `app.mcp(...)`, `app.server(...)`, and `app.tool(...)` unchanged.
3. Wire declared local servers into the existing server catalog before startup validation and downstream SDK capability calculation.
4. Reuse existing proxy operations for list, call, read, prompt get, and completion so policy, routes, events, and logs remain consistent.
5. Add docs and examples showing local declarations beside upstream MCP servers.
6. Rollback is additive: remove the local handle and adapter while preserving the existing upstream proxy pipeline.

## Open Questions

- Should `app.local(name)` be available on group handles for group-only local capabilities, or should local servers be declared globally and attached to groups through existing group server lists?
- Should resource template handlers support both parsed template variables and raw MCP params in the initial release?
- Should local tool metadata support output schemas immediately, or defer output schema helpers until broader structured result docs exist?

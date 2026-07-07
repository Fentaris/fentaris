## 1. Public API And Types

- [x] 1.1 Define local declaration metadata and handler types for tools, resources, resource templates, prompts, and completions
- [x] 1.2 Define `ProxyLocalHandle` with `tool`, `resource`, `resourceTemplate`, `prompt`, and `completion` declaration methods
- [x] 1.3 Add `app.local(name)` overloads to `McpProxy` without changing `app.tool(...)`, `app.mcp(...)`, or `app.server(...)` semantics
- [x] 1.4 Export the new local declaration and handler types from the public core entrypoints
- [x] 1.5 Add type tests for the recommended local declaration syntax and handler parameter/result inference

## 2. Declaration Registry And Adapter

- [x] 2.1 Implement an internal registry for local namespaces and declared capabilities
- [x] 2.2 Implement duplicate detection for tools, resources, resource templates, prompts, and completion handlers within a namespace
- [x] 2.3 Implement name and URI validation for local namespaces, tools, prompts, resources, and resource templates
- [x] 2.4 Implement a declared-capability transport adapter that satisfies `FentarisTransport`
- [x] 2.5 Implement exact resource matching and resource-template matching with deterministic exact-before-template precedence
- [x] 2.6 Add unit tests for registry reuse, duplicate validation, invalid declarations, and adapter list methods

## 3. Proxy Catalog Integration

- [x] 3.1 Materialize each local namespace as a Fentaris-owned server binding in the existing server catalog
- [x] 3.2 Detect collisions between local namespace names and configured upstream MCP server names before serving
- [x] 3.3 Ensure local namespaces participate in global and group-scoped server resolution
- [x] 3.4 Ensure downstream SDK capability declaration includes local tools, resources, prompts, and completions
- [x] 3.5 Add integration tests for mixed local and upstream capability listing

## 4. Local Execution Pipeline

- [x] 4.1 Route proxied local tool calls to declared local tool handlers through the existing tool call pipeline
- [x] 4.2 Route proxied local resource reads to exact resource and resource-template handlers
- [x] 4.3 Route proxied local prompt gets to declared local prompt handlers
- [x] 4.4 Route proxied local completion requests to declared local completion handlers
- [x] 4.5 Normalize local handler thrown errors and invalid results into structured MCP errors
- [x] 4.6 Add execution tests for local tool calls, resource reads, prompt gets, completions, unsupported completions, and handler failures

## 5. Governance, Middleware, Events, And Logs

- [x] 5.1 Ensure existing policy rules authorize local tools through the local namespace server name
- [x] 5.2 Ensure resource, resource-template, prompt, and completion policy checks apply before local handler invocation
- [x] 5.3 Ensure list responses filter denied local tools, resources, resource templates, and prompts
- [x] 5.4 Ensure global, server-scoped, group-scoped, and operation middleware can observe and control local capability requests
- [x] 5.5 Ensure local capability requests emit the same typed success, error, and after events as upstream capability requests
- [x] 5.6 Ensure contextual logs and audit metadata identify local namespace, operation, subject, target, and policy outcome
- [x] 5.7 Add tests proving denied local requests do not invoke handlers and that middleware, events, and logs match upstream behavior

## 6. Documentation

- [x] 6.1 Add docs for `app.local(name)` and local tool/resource/prompt/completion declarations
- [x] 6.2 Update proxy setup docs with an app that combines upstream MCP servers and local capabilities
- [x] 6.3 Update governance/auth docs to show policies for local namespaces using existing `.mcp(name)` rules
- [x] 6.4 Update middleware and observability docs to show local capability context and events
- [x] 6.5 Update extension API docs to position custom `FentarisTransport` as the advanced escape hatch
- [x] 6.6 Regenerate typed API reference if public exports or comments change

## 7. Verification

- [x] 7.1 Run `pnpm --filter @fentaris/core test`
- [x] 7.2 Run `pnpm --filter @fentaris/core build`
- [x] 7.3 Run `pnpm typecheck`
- [x] 7.4 Run `pnpm lint`
- [x] 7.5 Run `openspec status --change "local-capability-declarations"` and confirm the change is apply-ready

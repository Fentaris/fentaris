## Context

Fentaris currently models upstream MCP access through `FentarisTransport`, which only exposes `listTools`, `callTool`, and `close`. `McpServer` wraps that transport, and `McpProxy.createSdkServer()` registers downstream handlers for `tools/list` and `tools/call` while declaring `tools` and `logging` capabilities.

The MCP specification treats resources, prompts, and completion as first-class server capabilities alongside tools. This change covers the request/response portion of those server capabilities so Fentaris can aggregate them from multiple upstream MCP servers.

## Goals / Non-Goals

**Goals:**
- Add proxy support for `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, and `completion/complete`.
- Keep existing tool proxy behavior and names stable.
- Allow tool-only transports to keep working.
- Derive downstream capabilities from actual upstream support.
- Preserve upstream schema and content payloads except for Fentaris routing metadata and exposed names/URIs.

**Non-Goals:**
- Resource subscriptions and list-change notifications.
- Progress, cancellation, ping, and log forwarding.
- Roots, sampling, and elicitation.
- Generalized governance for non-tool operations.
- Implementing MCP protocol serialization directly instead of using the official SDK.

## Decisions

### Extend transports with optional feature methods

`FentarisTransport` will gain optional methods for resources, prompts, and completion rather than making every transport implement them immediately.

Alternative considered: create separate transport interfaces per capability and require all upstream wrappers to advertise a capability map. That is more explicit, but it would force a larger migration before any feature can ship. Optional methods keep existing tests and custom transports compatible.

### Use capability-aware wrappers in `McpServer`

`McpServer` will expose methods such as `listResources`, `readResource`, `listPrompts`, `getPrompt`, and `complete`, returning empty list responses or unsupported errors where appropriate. The wrapper will continue to apply per-user env/user transport resolution before invoking upstream methods.

Alternative considered: let `McpProxy` call transports directly. That would bypass the existing `McpServer` ownership boundary for env injection and isolation.

### Namespace prompts by name and resources by proxy URI

Prompt names will follow the existing tool naming style: `<server>__<prompt>`. Resources and resource templates will use Fentaris-owned proxy URIs so routing can be recovered from the URI alone. The proxy URI should encode both server name and original upstream URI or URI template.

Alternative considered: expose original resource URIs and attach server metadata under `_meta`. MCP clients call `resources/read` by URI, so routing must be recoverable without relying on client-preserved metadata.

### Keep completion references aligned with proxied names

`completion/complete` will accept proxied prompt names and proxied resource template URIs. Fentaris will translate the reference to the upstream prompt name or URI template before forwarding.

Alternative considered: expose completion only for prompts first. That would leave resource templates incomplete and create an inconsistent user experience.

### Declare downstream capabilities dynamically

`createSdkServer()` will declare `resources`, `prompts`, and `completions` only when at least one configured upstream can support the corresponding feature. If capability discovery is expensive, Fentaris may use transport method presence as the first approximation and refine after upstream capability discovery.

Alternative considered: always declare every capability and return empty results. That misleads clients during capability negotiation.

## Risks / Trade-offs

- Proxy URI design might become hard to change later -> Keep helper functions centralized and covered by round-trip tests.
- Upstream SDK capability APIs may differ by SDK version -> Verify `@modelcontextprotocol/sdk` support before implementation and add compatibility wrappers.
- Returning empty lists for unsupported upstreams can hide misconfiguration -> Log unsupported capability checks at debug level.
- Dynamic capability calculation can require async upstream inspection while `createSdkServer()` is currently synchronous -> Prefer method-presence capability declaration first, or adjust runtime creation carefully if SDK requires synchronous server construction.

## Migration Plan

1. Add optional transport methods and type exports.
2. Implement feature methods in native MCP upstream transports.
3. Add proxy mapping helpers for prompt names and resource URIs.
4. Register downstream SDK handlers and capabilities.
5. Add tests and docs.
6. Leave tool APIs untouched for rollback; disabling the new handlers restores tool-only behavior.

## Open Questions

- Should proxy resource URIs use `fentaris://resources/<server>/<encoded-uri>` or another stable scheme?
- Should proxied resources expose original URI in `_meta.fentaris.originalUri` for debugging?
- Should completion be declared if only prompts or only resource templates support it, or always when either exists?

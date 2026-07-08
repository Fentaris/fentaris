## Why

Fentaris's governance model is currently centered on tools, but MCP resources, prompts, and completion can expose sensitive data or shape model behavior. Once Fentaris proxies more MCP features, policy, middleware, context, events, and audit controls must apply consistently across every proxied capability.

## What Changes

- Generalize policy from tool-only permissions to operation/capability permissions.
- Add authorization and filtering for resource listing/reading, resource templates, prompt listing/getting, and completion requests.
- Extend unified proxy context with selected resource, prompt, and completion metadata.
- Add middleware and event coverage for non-tool operations while preserving existing tool middleware behavior.
- Add audit/rate-limit hooks for every MCP capability operation.
- Preserve existing `ToolPermission` compatibility through migration aliases or adapters.

## Capabilities

### New Capabilities
- `mcp-capability-governance`: Policy, middleware, events, context, and audit behavior for all proxied MCP capabilities.

### Modified Capabilities

## Impact

- Affected code: policy types and evaluators, governance group permission model, `ProxyOperation`, `ProxyContext`, route/event dispatch, logger metadata, docs.
- Public API impact: new generalized permission model; existing tool permission APIs should remain usable during migration.
- Security impact: resource and prompt access is explicitly governed rather than implicitly exposed.
- Dependency: should build on or coordinate with `proxy-mcp-server-features`.

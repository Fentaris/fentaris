## Why

Fentaris currently proxies MCP tools well, but MCP server features also include resources, resource templates, prompts, and completion. Supporting only `tools/list` and `tools/call` prevents Fentaris from acting as a complete MCP gateway for upstream servers that expose contextual data and prompt workflows.

This change adds request/response support for MCP server features first, leaving subscriptions, notifications, and client-originated features to separate changes.

## What Changes

- Extend Fentaris's upstream transport contract beyond tools to include resources, resource templates, prompts, and completion.
- Add proxy aggregation and routing for `resources/list`, `resources/read`, `resources/templates/list`, `prompts/list`, `prompts/get`, and `completion/complete`.
- Expose downstream MCP capabilities dynamically based on supported upstream features.
- Namespace prompt names and resource/template identifiers so multiple upstream servers can be safely aggregated.
- Preserve existing tool behavior and public tool naming compatibility.
- Defer resource subscriptions, list-change notifications, progress, cancellation, roots, sampling, elicitation, and generalized governance to follow-up changes.

## Capabilities

### New Capabilities
- `mcp-server-feature-proxy`: Proxy support for MCP server-side resources, resource templates, prompts, and completion.

### Modified Capabilities

## Impact

- Affected code: `packages/core/src/types.ts`, `packages/core/src/McpServer.ts`, `packages/core/src/McpProxy.ts`, upstream MCP transports, downstream exposure tests, docs.
- Public API impact: `FentarisTransport` gains additional optional MCP server feature methods.
- Compatibility: existing tool-only transports remain valid if the new methods are optional or capability-gated.
- Documentation impact: reference and guide docs must describe proxied tools, resources, prompts, and completion.

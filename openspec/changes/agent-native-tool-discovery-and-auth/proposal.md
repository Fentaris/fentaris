## Why

Fentaris is intended to be built and operated by AI agents, but agents currently lack a precise, bounded, machine-readable way to discover which MCP tools are available for a configured account or policy context. This makes setup, auth, and tool selection depend on hidden human knowledge, external logins, or trial and error.

## What Changes

- Add an agent-native tool discovery surface to the Fentaris CLI for listing, searching, and inspecting effective MCP tools.
- Add a simple CLI config section for MCP account selection:
  - `cli.mcpAccounts.<mcp>.default`
  - `cli.mcpAccounts.<mcp>.allowed`
- Allow agents to select a configured account or group with an `--as` style flag when discovering tools.
- Add auth inspection commands so agents can see which MCP accounts are available, authenticated, missing auth, or blocked.
- Add bounded discovery controls such as `--json`, `--compact`, `--limit`, `--cursor`, `--max-tokens`, `--mcp`, `--include`, and `--exclude`.
- Add targeted tool schema inspection for input and output schemas without requiring agents to load every schema for every tool.
- Make discovery handle stdio MCP servers by starting them when needed for discovery, with explicit controls for refresh and no-start behavior.
- Keep the separate CLI style/flag standards skill out of scope for this change.

## Capabilities

### New Capabilities
- `agent-native-tool-discovery`: Agent-friendly MCP tool discovery, auth visibility, schema inspection, and bounded CLI output for effective capabilities.

### Modified Capabilities

## Impact

- Fentaris CLI commands for tool discovery, auth status, account selection, and schema inspection.
- Fentaris config validation for `cli.mcpAccounts`.
- MCP server lifecycle handling during CLI discovery, especially stdio servers.
- Tool catalog and policy evaluation paths used to compute effective tools for a selected configured account.
- Documentation for agent-native CLI usage and machine-readable output contracts.

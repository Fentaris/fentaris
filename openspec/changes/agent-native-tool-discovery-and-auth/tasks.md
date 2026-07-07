## 1. Config Model

- [x] 1.1 Add `cli.mcpAccounts` types for MCP account defaults and allowed selectors.
- [x] 1.2 Extend config validation to require `default` and `allowed` for each configured MCP account entry.
- [x] 1.3 Validate that each MCP account `default` selector is present in its `allowed` array.
- [x] 1.4 Add config formatting/diagnostics for invalid MCP account selectors and missing defaults.
- [x] 1.5 Add unit tests for valid config, missing default, empty allowed list, and default-not-allowed cases.

## 2. Effective Tool Discovery Service

- [x] 2.1 Add an internal CLI-facing service that resolves MCP server config, selected `--as` selector, auth state, and policy-filtered effective tools.
- [x] 2.2 Reuse existing upstream MCP discovery paths instead of duplicating MCP initialize/list-tools protocol logic.
- [x] 2.3 Add compact tool metadata shape for list/search results.
- [x] 2.4 Add detailed tool metadata shape for single-tool inspection.
- [x] 2.5 Add per-MCP warnings and next actions for unavailable, unauthenticated, or policy-blocked servers.
- [x] 2.6 Add tests for raw upstream tools being filtered down to effective tools for a selected account context.

## 3. CLI Tools Commands

- [x] 3.1 Add `fentaris tools list` with `--json`, `--compact`, `--limit`, `--cursor`, `--max-tokens`, `--mcp`, `--as`, `--include`, and `--exclude`.
- [x] 3.2 Add `fentaris tools search <query>` with MCP/account filters, pagination, compact output, JSON output, and next actions.
- [x] 3.3 Add `fentaris tools get <tool>` for single-tool metadata and availability inspection.
- [x] 3.4 Add `fentaris tools schema <tool>` with `--input`, `--output`, and `--json`.
- [x] 3.5 Add CLI tests for default account selection, explicit `--as`, invalid `--as`, MCP filtering, and bounded list output.

## 4. JSON Output Contract

- [x] 4.1 Add a shared JSON envelope helper for agent-facing CLI commands.
- [x] 4.2 Ensure successful collection responses include `ok`, `data`, `pagination`, `warnings`, and `nextActions`.
- [x] 4.3 Ensure failed JSON responses include `ok: false`, stable error code, message, warnings, and recovery next actions when available.
- [x] 4.4 Implement best-effort `--max-tokens` response budgeting and narrowing guidance.
- [x] 4.5 Add tests for JSON envelopes, pagination metadata, error envelopes, and `--max-tokens` truncation/narrowing behavior.

## 5. Auth Discovery and Login Commands

- [x] 5.1 Add `fentaris tools auth list` to return configured MCP account defaults, allowed selectors, and known auth statuses without secrets.
- [x] 5.2 Add `fentaris tools auth status --mcp <mcp> --as <selector>` for one configured account selector.
- [x] 5.3 Add `fentaris tools auth login --mcp <mcp> --as <selector>` for configured selectors.
- [x] 5.4 Return machine-readable login instructions for device-code, browser, token, or delegated flows when login cannot finish non-interactively.
- [x] 5.5 Add tests for configured account listing, authenticated status, auth-required status, unsupported login mode, and unconfigured selector refusal.

## 6. Stdio Discovery Lifecycle

- [x] 6.1 Detect stdio MCP servers during CLI discovery and start them when required by default.
- [x] 6.2 Add `--no-start` behavior that avoids process startup and returns an actionable lifecycle diagnostic.
- [x] 6.3 Add `--refresh` behavior that bypasses cached discovery data and performs fresh discovery.
- [x] 6.4 Report discovery metadata such as transport kind, cache status, startup status, and refresh status.
- [x] 6.5 Add tests for stdio startup, no-start failure, refresh discovery, startup timeout, and process cleanup/reuse.

## 7. Documentation and Verification

- [x] 7.1 Document `cli.mcpAccounts` in the config reference with `default` and `allowed` examples.
- [x] 7.2 Document agent-native tool discovery workflows for list, search, get, schema, auth list, auth status, and auth login.
- [x] 7.3 Document large-server discovery guidance using `--compact`, `--limit`, `--cursor`, `--max-tokens`, `--include`, and `--exclude`.
- [x] 7.4 Run package tests covering config, CLI, MCP discovery, auth command behavior, and stdio lifecycle.
- [x] 7.5 Run build, typecheck, and docs generation checks required by the repo workflow.

## ADDED Requirements

### Requirement: CLI MCP account configuration
The system SHALL support a `cli.mcpAccounts` config object where each MCP key declares a `default` account selector and an `allowed` array of selectors that the CLI may use for agent-facing discovery and auth commands.

#### Scenario: Valid account configuration
- **WHEN** config validation reads `cli.mcpAccounts.github.com.default` as `user:gabry848` and `allowed` includes `user:gabry848`
- **THEN** validation succeeds and CLI discovery uses `user:gabry848` as the default selector for `github.com`

#### Scenario: Default account missing from allowed list
- **WHEN** config validation reads an MCP account config whose `default` selector is not present in `allowed`
- **THEN** validation fails with a diagnostic that identifies the MCP key and the missing selector

### Requirement: Effective tool listing
The system SHALL provide `fentaris tools list` to list effective MCP tools for the selected configured account context, with JSON output, MCP filtering, account selection, compaction, pagination, include/exclude controls, and best-effort token budgeting.

#### Scenario: List compact tools for one MCP
- **WHEN** an agent runs `fentaris tools list --mcp github.com --as user:gabry848 --compact --json`
- **THEN** the CLI returns a JSON envelope containing only tools allowed for `user:gabry848` on `github.com`

#### Scenario: List uses configured default account
- **WHEN** an agent runs `fentaris tools list --mcp github.com --json` and `github.com` has a configured default selector
- **THEN** the CLI lists effective tools for the configured default selector

#### Scenario: Account selector is not allowed for MCP
- **WHEN** an agent runs `fentaris tools list --mcp github.com --as group:unknown --json` and `group:unknown` is not listed in `cli.mcpAccounts.github.com.allowed`
- **THEN** the CLI returns a machine-readable error with a code, the allowed selectors, and a next action for inspecting configured auth accounts

#### Scenario: Collection output is bounded
- **WHEN** an agent runs `fentaris tools list --json --limit 20 --max-tokens 4000`
- **THEN** the CLI returns at most 20 listed tools and keeps the response within a best-effort output budget while providing pagination or narrowing next actions when more tools are available

### Requirement: Tool search and detail inspection
The system SHALL provide commands to search tools and inspect one selected tool without requiring the agent to load all tool schemas.

#### Scenario: Search tools
- **WHEN** an agent runs `fentaris tools search "issue" --mcp github.com --as user:gabry848 --limit 10 --json`
- **THEN** the CLI returns matching effective tools with compact metadata and follow-up commands for exact inspection

#### Scenario: Inspect a selected tool
- **WHEN** an agent runs `fentaris tools get github.create_issue --json`
- **THEN** the CLI returns the selected tool name, description, MCP source, effective availability, auth status, side-effect metadata when available, and next actions for schema inspection

### Requirement: Targeted tool schema inspection
The system SHALL provide targeted schema inspection for a selected tool's input and output schemas.

#### Scenario: Inspect input and output schemas
- **WHEN** an agent runs `fentaris tools schema github.create_issue --input --output --json`
- **THEN** the CLI returns the available input and output schema details for `github.create_issue` without returning schemas for unrelated tools

#### Scenario: Output schema is unavailable
- **WHEN** an agent requests an output schema for a tool whose upstream MCP server does not declare one
- **THEN** the CLI returns explicit schema availability metadata instead of inventing an output schema

### Requirement: Tool auth account discovery
The system SHALL provide `fentaris tools auth list` and `fentaris tools auth status` so agents can inspect configured MCP account selectors, defaults, and authentication state.

#### Scenario: List configured auth accounts
- **WHEN** an agent runs `fentaris tools auth list --json`
- **THEN** the CLI returns each MCP key, its default selector, its allowed selectors, and any known auth status without exposing secrets

#### Scenario: Inspect auth status for one account
- **WHEN** an agent runs `fentaris tools auth status --mcp github.com --as user:gabry848 --json`
- **THEN** the CLI returns whether that selector is authenticated, requires login, is unsupported, or is blocked by configuration or policy

### Requirement: Tool auth login affordance
The system SHALL provide `fentaris tools auth login` for configured MCP account selectors and SHALL return machine-readable login instructions when authentication cannot complete non-interactively.

#### Scenario: Login for configured account
- **WHEN** an agent runs `fentaris tools auth login --mcp github.com --as user:gabry848`
- **THEN** the CLI starts the configured login flow or returns a machine-readable instruction describing the required device-code, browser, token, or delegated login step

#### Scenario: Login requested for unconfigured selector
- **WHEN** an agent requests login for a selector that is not allowed for the MCP
- **THEN** the CLI refuses the login request and returns allowed selectors with a next action for auth account discovery

### Requirement: Stdio discovery lifecycle
The system SHALL start stdio MCP servers as needed for tool discovery by default and SHALL expose controls to refresh discovery or avoid process startup.

#### Scenario: Stdio server starts for discovery
- **WHEN** an agent lists tools for a configured stdio MCP server that is not already running
- **THEN** Fentaris starts the server, performs MCP initialization and tool listing, applies auth and policy filtering, and returns discovery metadata

#### Scenario: No-start discovery avoids process startup
- **WHEN** an agent runs `fentaris tools list --mcp local-stdio --no-start --json` and the stdio server is not already available
- **THEN** the CLI does not start the process and returns an actionable lifecycle diagnostic

#### Scenario: Discovery refresh bypasses cache
- **WHEN** an agent runs `fentaris tools list --mcp local-stdio --refresh --json`
- **THEN** Fentaris performs a fresh discovery attempt and reports refreshed discovery metadata

### Requirement: Agent-friendly JSON envelope
The system SHALL return predictable JSON envelopes for agent-facing tool discovery and auth commands.

#### Scenario: Successful JSON response
- **WHEN** an agent runs an agent-facing tools command with `--json`
- **THEN** the response includes `ok`, `data`, `warnings`, and `nextActions`, and includes `pagination` for collection responses

#### Scenario: Failed JSON response
- **WHEN** an agent-facing tools command fails with `--json`
- **THEN** the response includes `ok: false`, a stable error code, a human-readable message, warnings when relevant, and actionable next actions when recovery is possible

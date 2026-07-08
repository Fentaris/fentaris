# Fentaris CLI Command Patterns

Use this reference for concrete command patterns. Keep examples short and update them when the CLI contract changes.

## Tool Discovery

Prefer these command shapes:

```bash
fentaris tools list --json
fentaris tools list --mcp github.com --json
fentaris tools list --as user:gabry848 --mcp github.com --compact --limit 20 --json
fentaris tools search "issues" --as user:gabry848 --limit 10 --json
fentaris tools get github.create_issue --include input-schema,output-schema --json
fentaris tools schema github.create_issue --input --json
fentaris tools schema github.create_issue --output --json
```

Use `tools search` instead of `tools list` when the caller has an intent or keyword and does not need the full inventory.

Use `tools get` for metadata about one tool. Use `tools schema` when constructing input or validating expected output.

## Tool List

Purpose: list available tools after applying MCP scope, Fentaris identity, account availability, and policy.

Recommended flags:

- `--json`
- `--compact`
- `--limit`
- `--cursor`
- `--as`
- `--mcp`
- `--include`
- `--exclude`
- `--verbose`

Compact output must preserve:

- tool id/name
- MCP/server id
- availability/auth status
- short description or title
- next action to inspect schema or auth when needed

## Tool Search

Purpose: find tools by short query or intent without dumping full discovery.

Examples:

```bash
fentaris tools search "issues" --as user:gabry848 --json
fentaris tools search "repo" --mcp github.com --limit 10 --json
```

Search rules:

- Encourage short natural queries.
- Default to bounded results.
- Include enough result metadata to decide whether `tools get` or `tools schema` is the next step.
- Include `nextActions` pointing to exact follow-up commands.

## Tool Get

Purpose: get details about one tool without forcing full schema payloads.

Examples:

```bash
fentaris tools get github.create_issue --json
fentaris tools get github.create_issue --include input-schema,output-schema --json
```

Rules:

- Return stable metadata by default.
- Require `--include` for verbose schemas, examples, or upstream details.
- Suggest `tools schema <tool> --input --json` when input construction is the next likely step.

## Tool Schema

Purpose: inspect input and output schema for a tool.

Examples:

```bash
fentaris tools schema github.create_issue --input --json
fentaris tools schema github.create_issue --output --json
fentaris tools schema github.create_issue --input --output --compact --json
```

Rules:

- Use `--input` when building a tool call.
- Use `--output` when validating or explaining expected results.
- Return both only when explicitly requested.
- Keep schema output validatable and avoid mixing prose into schema fields.

## Tool Auth

Prefer these command shapes:

```bash
fentaris tools auth list --json
fentaris tools auth status --mcp github.com --as user:gabry848 --json
fentaris tools auth login --mcp github.com --as user:gabry848
```

Rules:

- `auth list` shows which MCP servers/accounts require auth or have available sessions.
- `auth status` checks one MCP and one Fentaris identity when possible.
- `auth login` starts authorization for an MCP server with a Fentaris identity.
- Output must distinguish upstream account status from Fentaris identity and policy status.
- If an account is not allowed, return a policy/auth error with a safe next action.

## MCP Stdio Discovery

When a configured MCP server uses stdio and discovery needs the server process:

1. Read the server config.
2. Detect stdio transport.
3. Start the process in discovery mode.
4. Run MCP initialize/list_tools.
5. Apply Fentaris auth, account, and policy filtering.
6. Return the filtered result.
7. Stop the process or cache it briefly.

Default behavior should be agent-friendly: start automatically when needed.

Optional control flags:

```bash
fentaris tools list --mcp github.com --no-start --json
fentaris tools list --mcp github.com --refresh --json
```

Avoid requiring a separate manual startup command for normal discovery.

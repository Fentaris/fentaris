## Context

Fentaris already proxies MCP servers, evaluates governance, supports multiple upstream transports, and has capability-manifest concepts for edge execution. The missing product surface is an agent-native CLI path that lets an AI agent inspect effective tools, required auth, and schemas without relying on hidden dashboard state or loading an unbounded catalog into context.

The CLI must serve two audiences at once: local setup/debugging by humans and autonomous use by AI agents. For this change, the agent use case is primary. Commands must be machine-readable, filterable, and explicit about follow-up commands.

## Goals / Non-Goals

**Goals:**

- Let agents discover the effective MCP tools available for a configured account/group context.
- Add simple config for CLI-visible MCP account choices using `cli.mcpAccounts.<mcp>.default` and `cli.mcpAccounts.<mcp>.allowed`.
- Provide auth status and login affordances for the configured MCP accounts.
- Provide bounded JSON output with pagination, filtering, compaction, and token budgeting.
- Provide targeted input/output schema inspection for a selected tool.
- Start stdio MCP servers as needed during discovery while exposing controls to refresh or avoid startup.

**Non-Goals:**

- Create the separate CLI style/flag standards skill.
- Replace existing governance policy semantics.
- Introduce a new interactive dashboard for tool discovery.
- Store raw secrets in the Fentaris config file.
- Guarantee that upstream providers expose every account-scoped capability before authentication succeeds.

## Decisions

### Use a simple CLI account config

Config will support:

```json
{
  "cli": {
    "mcpAccounts": {
      "github.com": {
        "default": "user:gabry848",
        "allowed": ["user:gabry848", "group:testers"]
      }
    }
  }
}
```

The `default` value MUST be present in `allowed`. Account selectors are strings using existing governance-style prefixes where possible, such as `user:<id>` and `group:<id>`.

Alternative considered: a larger `authProfiles` and `principals` model. It is more expressive, but it is too heavy for the immediate workflow and makes simple agent discovery harder to configure.

### Use `--as` for account/group selection

Tool discovery commands will accept `--as <selector>` to select one configured account or group. If omitted, the command uses the configured default for the selected MCP server when the command is scoped to one MCP. For cross-MCP commands, each MCP uses its own default unless the selected `--as` is allowed for that MCP.

Alternative considered: `--principal`. It is precise but less natural for agents and users configuring Fentaris.

### Keep tool discovery progressive

The default list command returns compact metadata, not every tool schema. Agents use follow-up commands for details:

```bash
fentaris tools list --mcp github.com --as user:gabry848 --compact --json
fentaris tools search "issue" --mcp github.com --as user:gabry848 --limit 10 --json
fentaris tools get github.create_issue --json
fentaris tools schema github.create_issue --input --output --json
```

All discovery commands that can return collections support `--json`, `--compact`, `--limit`, `--cursor`, `--max-tokens`, `--mcp`, `--include`, and `--exclude`.

Alternative considered: include all schemas in `tools list`. This would be simpler, but large MCP servers can create unusable context volume.

### Return stable JSON envelopes

JSON output will use a predictable envelope:

```json
{
  "ok": true,
  "data": [],
  "pagination": {
    "limit": 20,
    "nextCursor": null
  },
  "warnings": [],
  "nextActions": []
}
```

Errors use the same envelope shape with `ok: false`, an error code, and actionable `nextActions` where possible. This makes failures recoverable by agents.

### Discovery computes effective tools

The CLI does not merely list raw upstream MCP tools. It resolves MCP config, selected account/group, auth state, upstream capability discovery, Fentaris policy, and tool filtering to return effective tools. Raw upstream details can be exposed through explicit diagnostic flags, but the primary output is what the selected agent context can use now.

### Stdio servers are lifecycle-managed for discovery

When a selected MCP server uses stdio and is not running, discovery starts it long enough to perform MCP initialization and tool listing. Results may be cached with metadata such as discovery time, transport kind, and cache status. Commands expose:

```bash
--refresh
--no-start
```

Default behavior starts the server when needed. `--no-start` fails with an actionable auth/lifecycle diagnostic instead of starting a process.

### Auth commands are grouped under tools auth

The initial CLI surface is:

```bash
fentaris tools auth list --json
fentaris tools auth status --mcp github.com --as user:gabry848 --json
fentaris tools auth login --mcp github.com --as user:gabry848
```

These commands report configured accounts, defaults, allowed selectors, current auth status, and login commands or modes. They do not expose tokens or secrets.

## Risks / Trade-offs

- [Risk] Account selectors in config are bypassable by agents editing local files. -> Treat this config as CLI guidance, not a security boundary; enforcement remains in Fentaris policy and credential storage.
- [Risk] `--max-tokens` cannot be exact across every tokenizer. -> Implement it as a conservative output budget using measured/estimated serialized size and document that it is best-effort.
- [Risk] Starting stdio servers during discovery may have side effects or be slow. -> Default to startup because it is agent-friendly, but expose `--no-start`, timeouts, and clear lifecycle warnings.
- [Risk] Upstream MCP servers may not provide output schemas. -> Return explicit schema availability metadata and avoid fabricating schemas.
- [Risk] Cross-MCP discovery can hide per-server auth failures. -> Return per-MCP warnings and `nextActions` for each unavailable server.

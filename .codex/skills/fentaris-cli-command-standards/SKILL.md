---
name: fentaris-cli-command-standards
description: Design, implement, review, and document Fentaris CLI commands consistently. Use when Codex changes command names, command hierarchy, flags, help text, JSON output, errors, exit behavior, pagination, auth/account identity handling, MCP discovery commands, or agent-friendly CLI behavior.
---

# Fentaris CLI Command Standards

## Overview

Use this skill to make Fentaris CLI commands predictable for humans and agents. Treat the CLI as a stable interface: commands must be discoverable, scriptable, compact when needed, and explicit about auth, policy, identity, and next steps.

## Workflow

1. Identify the command category: discovery, schema inspection, auth/account, mutation, config, diagnostics, or developer workflow.
2. Choose the smallest command shape that fits the task. Prefer stable nouns and verbs over clever aliases.
3. Apply the required flag profile for the command category.
4. Define human output first for readability, then define `--json` output as the machine contract.
5. Specify error shape, exit code, and any safe retry or next action.
6. Add or update tests for parsing, success output, failure output, and help text.
7. If behavior is user-facing, use `$fentaris-docs-style` for docs updates before finishing.

Read `references/command-patterns.md` when designing or changing `fentaris tools ...`, auth/account discovery, schema inspection, pagination, compact output, or MCP stdio discovery behavior.

## Command Shape

- Prefer `fentaris <domain> <action>` for simple resources: `fentaris tools list`, `fentaris tools search`.
- Use `fentaris <domain> <resource> <action>` only when the middle resource prevents ambiguity: `fentaris tools auth status`.
- Keep verbs boring and consistent: `list`, `search`, `get`, `schema`, `status`, `login`, `logout`, `run`, `validate`, `doctor`.
- Avoid command aliases unless an existing public command already depends on them.
- Keep public CLI language approachable. Avoid exposing internal terms such as `principal` when `identity`, `account`, `user`, `group`, or `--as` is clearer.

## Flag Profiles

Do not add every standard flag to every command. Add flags by command category.

### All Scriptable Commands

- `--json`: emit the canonical JSON envelope.
- `--verbose`: include extra diagnostics for humans; never required for normal agent operation.

### Discovery Commands

Use for commands such as `list`, `search`, `get`, and discovery-flavored `status`.

- `--json`: required for machine use.
- `--compact`: reduce fields and prose while preserving identifiers, status, and next actions.
- `--limit`: bound result count.
- `--cursor`: continue pagination. Prefer cursor pagination over offset for unstable upstream data.
- `--include`: opt into expensive or verbose fields.
- `--exclude`: remove optional fields from otherwise useful output.
- `--as`: evaluate visibility and policy as a Fentaris identity.
- `--mcp`: scope discovery to one MCP upstream or configured server.

Consider `--max-tokens` only for commands that can cheaply estimate rendered output size. Prefer `--compact`, `--limit`, and `--include` first.

### Schema Commands

- Use explicit switches such as `--input` and `--output` instead of returning every schema by default.
- Support `--json`.
- Support `--compact` when schemas contain descriptions or examples that can be omitted.

### Mutating Commands

- Support `--json` for result reporting.
- Require explicit target arguments. Do not infer destructive targets from broad discovery defaults.
- Require confirmation for destructive operations unless `--yes` or an equivalent non-interactive flag is supplied.
- Make dry-run behavior available when the command has broad or irreversible effects.

## Identity And Auth

- Use `--as user:<name>` or `--as group:<name>` as the public convention for Fentaris identity.
- Define `--as` as: use this Fentaris identity to calculate visible tools, upstream accounts, policies, and permissions.
- Keep upstream account identity separate from Fentaris identity in config, output, and docs.
- Prefer explicit config for MCP accounts:

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

## JSON Output Contract

Every `--json` command must return a stable envelope.

Success:

```json
{
  "ok": true,
  "data": {},
  "pagination": null,
  "warnings": [],
  "nextActions": []
}
```

Failure:

```json
{
  "ok": false,
  "error": {
    "code": "AUTH_REQUIRED",
    "message": "Authentication is required for github.com",
    "details": {}
  },
  "warnings": [],
  "nextActions": []
}
```

Rules:

- Keep `ok`, `warnings`, and `nextActions` present in both success and failure envelopes.
- Use `data` for successful payloads only.
- Use `error.code` as a stable programmatic identifier in `SCREAMING_SNAKE_CASE`.
- Put human-readable context in `error.message`.
- Put structured remediation details in `error.details`, not in free-form prose.
- Use `pagination: null` for non-paginated commands.
- Use lower camel case for JSON field names unless interoperating with an upstream schema that must be preserved.

## Next Actions

Use `nextActions` to help agents continue without guessing.

```json
{
  "nextActions": [
    {
      "description": "Inspect the input schema for this tool",
      "command": "fentaris tools schema github.create_issue --input --json"
    }
  ]
}
```

Rules:

- Include only concrete, safe next commands.
- Prefer one to three actions.
- Do not include tutorial prose, marketing copy, or long explanations.
- Do not suggest commands that require destructive effects without making confirmation explicit.

## Human Output

- Default human output should be concise and scannable.
- Show stable IDs, names, status, and the next useful command.
- Avoid dumping schemas, raw config, or large descriptions unless requested with `--include`, `--verbose`, or a dedicated subcommand.
- Keep warnings visible in human output and present in JSON output.

## MCP Discovery

- For stdio MCP servers, default discovery should start the server when needed, run discovery, apply Fentaris auth/account/policy filtering, and shut down or briefly cache the process.
- Provide explicit control only where useful: `--no-start`, `--refresh`, or equivalent.
- Do not require agents to manually start stdio MCP servers for ordinary discovery commands.

## Validation Checklist

Before finishing a CLI change, verify:

- Help text includes purpose, required args, important flags, and at least one realistic example.
- `--json` output uses the canonical envelope for success and failure.
- Discovery output can be bounded by `--limit` and scoped by relevant filters.
- Auth/account behavior distinguishes Fentaris identity from upstream account identity.
- Errors have stable codes and useful next actions.
- Tests cover command parsing, help output, JSON success, JSON failure, and at least one compact or paginated path when applicable.

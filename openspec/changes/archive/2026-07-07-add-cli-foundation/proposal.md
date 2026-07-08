## Why

Fentaris has a capable core proxy, governance, auth, and transport runtime, but the first-run developer experience is still manual and scattered across docs and low-level CLI helpers. A focused CLI foundation will let developers create, run, validate, and prepare a Fentaris proxy with minimal input while keeping deployment as a later step.

## What Changes

- Add a first-class `fentaris init [project-name]` workflow that creates a ready-to-run project from a default template.
- Add initial top-level commands: `fentaris dev`, `fentaris check`, `fentaris doctor`, `fentaris build`, and `fentaris secrets set`.
- Keep `fentaris deploy` out of the initial implementation while designing build output so a later deploy command can consume it.
- Reorganize the existing auth-oriented CLI helpers behind the new command surface without losing local encrypted credential support.
- Add a polished terminal output style with clear sections, color, status symbols, and concise next steps.
- Generate a default project that includes a working proxy, one stdio MCP upstream, one unauthenticated HTTP MCP upstream at `https://mcp.specification.website/mcp`, two users, one group, simple policy, rate-limit example, `.gitignore`, and initialized git repository.
- Add health checks and repair prompts so `doctor` can report issues and ask before attempting each supported fix.

## Capabilities

### New Capabilities

- `cli-project-init`: Covers project creation, template generation, package-manager selection, dependency installation, git initialization, doctor execution, and first-run terminal output.
- `cli-project-runtime`: Covers local development and build commands for running and packaging a Fentaris project without deploying it.
- `cli-health-validation`: Covers project validation with `check` and machine/environment validation with `doctor`, including MCP/tool discovery where appropriate.
- `cli-secrets-management`: Covers the top-level `secrets set` workflow and compatibility with existing encrypted local auth/credential storage.

### Modified Capabilities

- None.

## Impact

- Affects `packages/cli` command parsing, output formatting, project scaffolding, and auth/secrets helper organization.
- May add CLI dependencies for argument parsing, prompts, colored output, package-manager detection, and process execution.
- Adds template files for generated Fentaris projects.
- Exercises existing `@fentaris/core` APIs for `McpProxy`, MCP transports, local auth, users, groups, policy, and rate limiting.
- Adds tests for CLI command behavior, template generation, validation, and safe error handling.

## Context

Fentaris already has a `packages/cli` package, but the current executable only exposes low-level `fentaris auth ...` helpers for local encrypted credentials. The product needs a top-level CLI that makes the first project creation path fast and reliable while preserving the existing auth storage primitives.

The first supported command set is `fentaris init`, `fentaris dev`, `fentaris check`, `fentaris doctor`, `fentaris build`, and `fentaris secrets set`. `fentaris deploy` remains a later milestone. The generated project must demonstrate real Fentaris value immediately: proxy setup, stdio upstream, remote unauthenticated HTTP upstream, users, groups, policy, rate limiting, and local auth/secrets.

## Goals / Non-Goals

**Goals:**

- Provide a polished first-run workflow where `fentaris init [project-name]` creates a ready-to-run project with minimal prompts.
- Keep `check` focused on the current Fentaris project and `doctor` focused on the local machine/runtime environment.
- Preserve encrypted local credential support while exposing a simpler top-level `fentaris secrets set` command.
- Generate projects that can run with `fentaris dev` and produce a local build artifact with `fentaris build`.
- Use concise, colored, sectioned terminal output inspired by GitButler-style command feedback.
- Initialize git and write a `.gitignore` for generated projects.

**Non-Goals:**

- No `fentaris deploy` implementation in this change.
- No cloud provisioning, hosted secret storage, or remote project registry.
- No invasive system package installation without explicit per-fix user approval.
- No support for initializing into non-empty directories beyond a clean, actionable error.
- No broad template marketplace; only a default template is required.

## Decisions

### Command Router

Use a structured CLI command router instead of extending the current manual `argv` parsing. The existing `auth` helpers can be retained as internal operations or compatibility subcommands, but the user-facing path must support top-level commands and nested commands like `secrets set`.

Alternative considered: keep manual parsing. This is sufficient for the current auth helpers but becomes brittle once prompts, aliases, help text, nested commands, and testable command behavior are needed.

### Init Order

`fentaris init [project-name]` resolves the project name first, then checks the target directory, detects package managers, asks only when multiple viable managers are available, writes the template, installs dependencies, runs `doctor`, and prints next steps.

Package-manager selection happens before writing template files because generated scripts, lockfile expectations, and install commands depend on the selected manager.

### Default Template

The default template will generate a TypeScript project with:

- `src/index.ts` containing the runnable proxy example.
- `fentaris.config.ts` or equivalent CLI-discoverable project metadata.
- `package.json`, `tsconfig.json`, `.env.example`, and `.gitignore`.
- `.fentaris/auth/credentials.enc.json` and `.fentaris/auth/upstream-auth.json` initialized through Fentaris's local auth primitives.

The example proxy includes one stdio MCP upstream, one remote unauthenticated HTTP MCP upstream at `https://mcp.specification.website/mcp`, two users, one group, a limited unauthenticated or low-privilege user path, a full-permission user outside the group, and a rate-limit example.

### Auth and Users in Template

The generated template must be clear about demo credentials and production rotation. It can generate local development API keys and print them once, but raw secrets must not be committed. `.gitignore` must exclude encrypted local credentials and local env files unless the implementation chooses a safe non-secret seed file.

The template demonstrates one low-permission user and one full-permission user outside the limited group. The exact naming can be `guest` and `admin` unless implementation finds established Fentaris docs naming patterns worth reusing.

### Check vs Doctor

`fentaris check` validates the current Fentaris project: config, expected files, secrets references, MCP server declarations, connectivity where enabled, tool discovery, and policy/tool mismatches.

`fentaris doctor` validates the local environment: Node version, selected package manager, install availability, git, Docker warning readiness, port availability, CLI cache/write permissions, and other local prerequisites. It can run outside a Fentaris project.

### Doctor Fixes

`doctor` reports detected problems in order and asks for approval for each supported fix one at a time. Fixes should prefer project-local or user-local changes. For system dependencies such as Docker, `doctor` should give instructions or open a clearly approved install path only if a safe implementation exists.

### Dev and Build

`fentaris dev` discovers the project entrypoint/config and runs the generated project locally. It should fail with a clear error if invoked outside a Fentaris project.

`fentaris build` produces a local deterministic artifact, initially under `.fentaris/build`, and may use the project's TypeScript/build tooling rather than a cloud service. The artifact should be suitable for a future `deploy` command or Docker packaging work.

## Risks / Trade-offs

- Remote HTTP demo server availability can make first-run validation flaky -> Treat remote connectivity failures as warnings during init and document that the stdio server still demonstrates local behavior.
- Stdio filesystem demos can expose too much local filesystem access -> Scope the filesystem server to a safe demo directory and call that out in generated comments.
- Generated API keys can be mishandled -> Print demo keys once, write `.env.example`, and ensure real secret files are ignored by git.
- `doctor --fix` can become too invasive -> Require one prompt per fix and keep system-level installs conservative.
- Package-manager detection can be surprising in nested monorepos -> Prefer explicit user selection when multiple managers are detected and record the selection in generated project metadata.
- Build semantics may drift toward deployment too early -> Keep build local and artifact-oriented; leave cloud behavior for a later deploy change.

## Migration Plan

1. Introduce the new command router while preserving existing `fentaris auth ...` behavior or mapping it to the new secrets/auth internals.
2. Add the default template and project discovery logic.
3. Implement `init`, then `doctor`, then `check`, then `dev`, `build`, and `secrets set`.
4. Update docs to present the CLI path as the recommended quickstart.
5. Keep rollback simple by leaving existing core APIs unchanged and avoiding changes to generated projects outside CLI-owned files.

## Open Questions

- Whether the project metadata file should be `fentaris.config.ts`, package.json metadata, or both.
- Whether `fentaris dev` should directly run TypeScript through a runtime dependency or invoke the selected package manager script.
- Whether compatibility `fentaris auth ...` commands remain documented or become hidden legacy commands.

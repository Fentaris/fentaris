---
name: fentaris-project-setup
description: Create, configure, and validate new Fentaris proxy projects for external users. Use when the user wants to start a new Fentaris project, create an MCP proxy, choose upstream MCP servers, configure endpoint/auth/secrets/policies, run initial checks, or understand how a generated Fentaris proxy works. Do not use for changing the Fentaris framework repository itself.
---

# Fentaris Project Setup

Use this skill to take an external user from intent to a working Fentaris proxy project.

## Core Workflow

1. Discover the goal before generating files. Ask only the missing high-value questions:
   - What should the proxy connect to: stdio MCP servers, Streamable HTTP MCP servers, SSE/HTTP upstreams, or a mix?
   - Who will use it: local developer, internal team, multi-tenant app, or production-facing service?
   - What controls are needed: API-key auth, users/groups, policies, approvals, logging, secrets, tenant routing?
   - What runtime preference exists: package manager, port, host, endpoint path, TypeScript style, existing app or new directory?
2. Read `references/project-types.md` when selecting the project shape.
3. Prefer the Fentaris CLI for new projects. Use `fentaris init <name>` when available, then configure the generated project instead of hand-building boilerplate.
4. Prefer high-level `@fentaris/core` application builders: `fentaris(...)`, `mcp(...)`, `policy(...)`, `group(...)`, `user(...)`, and transport helpers. Use the advanced low-level API only when the user explicitly asks for direct proxy/transport wiring or the requirement cannot fit the high-level API.
5. Read `references/configuration.md` before editing endpoint, auth, policy, secrets, or package scripts.
6. Validate with the most relevant commands available in the project, typically `fentaris check --offline`, `fentaris doctor`, package-manager build/typecheck scripts, and `fentaris doctor --runtime` after starting the proxy.
7. Do not invent deploy commands. Fentaris deploy is not available yet; explain that the CLI is expected to provide a simpler deploy flow later and keep the current setup deploy-ready.
8. When unsure about current Fentaris behavior, consult the official docs at `https://fentaris.mintlify.app` or local docs if working inside the Fentaris repository.
9. Finish with a concise implementation explanation. Read `references/final-explanation.md` for the expected shape.

## Agent-Friendly CLI Use

Prefer explicit, automation-safe inputs. When the installed CLI supports `--non-interactive`, use it for agent-driven commands and pass required options explicitly. If the CLI asks for interactive input, stop and ask the user instead of guessing secrets or production choices.

## Safety Defaults

- Keep local development bound to `127.0.0.1` unless the user intentionally exposes it.
- Keep the client endpoint path stable, usually `/mcp`.
- Add auth and policy before recommending exposure outside local development.
- Do not print secret values. Use secret stores or environment variables.
- Avoid deep imports from `@fentaris/core/dist/*` or source-layout paths.

## Resource Routing

- Read `references/project-types.md` to choose between local demo, team proxy, production-shaped proxy, existing-app embedding, or custom transport work.
- Read `references/configuration.md` for concrete setup and validation guidance.
- Read `references/final-explanation.md` before the final response for setup tasks.

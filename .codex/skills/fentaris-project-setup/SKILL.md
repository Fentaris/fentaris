---
name: fentaris-project-setup
description: Introduce Fentaris to external users, help them understand its value, choose the right proxy workflow, and create/configure a new Fentaris project. Use when the user wants to learn how Fentaris works, decide how to structure users/devices/cloud/local usage, create an MCP proxy, configure upstream MCP servers, endpoint/auth/secrets/policies, run initial checks, or understand the generated project. Do not use for changing the Fentaris framework repository itself.
---

# Fentaris Project Setup

Use this skill to guide an external user from "what is Fentaris and how should I use it?" to a working, validated proxy project.

## Core Workflow

1. Start with a short introduction when the user is new or asks broad setup questions:
   - Explain that Fentaris centralizes MCP servers behind one controlled endpoint.
   - Explain the value in practical terms: stable MCP client URL, centralized server configuration, users/groups, policy, secrets, logging, and future deploy ergonomics.
   - Avoid long marketing copy; use a compact mental model and then move into discovery.
2. Read `references/discovery.md` and ask only the missing high-value questions needed to choose a workflow:
   - Who will use the proxy: one developer, multiple local users, a team, multiple machines, cloud service, or tenant-based app?
   - Where will it run: local laptop, shared workstation, private server, container, cloud runtime, or not decided?
   - Which MCP servers must be connected, and which transport do they use: stdio, Streamable HTTP, SSE/HTTP, or unknown?
   - What auth exists today: API keys, headers from an upstream app, local users, or no auth yet?
   - What controls are needed: users/groups, policies, approvals, logs/audit, secrets, per-env routing?
3. Clarify current limitations before designing around them:
   - OAuth 2.1 is not supported yet. Do not design the project around OAuth 2.1 as an available Fentaris feature.
   - Deploy is not available yet. Do not invent deploy commands; keep the project deploy-ready and mention that the CLI is expected to provide a smoother deploy flow later.
4. Read `references/project-types.md` and recommend one setup workflow before creating files. State the recommendation briefly and explain the tradeoff.
5. Prefer the Fentaris CLI for new projects. Use `fentaris init <name>` when available, then configure the generated project instead of hand-building boilerplate.
6. Prefer high-level `@fentaris/core` application builders: `fentaris(...)`, `mcp(...)`, `policy(...)`, `group(...)`, `user(...)`, and transport helpers. Use the advanced low-level API only when the user explicitly asks for direct proxy/transport wiring or the requirement cannot fit the high-level API.
7. Read `references/configuration.md` before editing endpoint, auth, policy, secrets, users, groups, MCP servers, or package scripts.
8. Validate with the most relevant commands available in the project, typically `fentaris check --offline`, `fentaris doctor`, package-manager build/typecheck scripts, and `fentaris doctor --runtime` after starting the proxy.
9. When unsure about current Fentaris behavior, consult the official docs at `https://fentaris.mintlify.app` or local docs if working inside the Fentaris repository.
10. Finish with a concise implementation explanation. Read `references/final-explanation.md` for the expected shape.

## Agent-Friendly CLI Use

Prefer explicit, automation-safe inputs. When the installed CLI supports `--non-interactive`, use it for agent-driven commands and pass required options explicitly. If the CLI asks for interactive input, stop and ask the user instead of guessing secrets or production choices.

## Safety Defaults

- Keep local development bound to `127.0.0.1` unless the user intentionally exposes it.
- Keep the client endpoint path stable, usually `/mcp`.
- Add auth and policy before recommending exposure outside local development.
- Treat OAuth 2.1 as unsupported for now; suggest API-key/header-based identity or a trusted upstream auth boundary when appropriate.
- Do not print secret values. Use secret stores or environment variables.
- Avoid deep imports from `@fentaris/core/dist/*` or source-layout paths.

## Resource Routing

- Read `references/discovery.md` before asking onboarding/setup questions.
- Read `references/project-types.md` to choose between local demo, team proxy, production-shaped proxy, existing-app embedding, or custom transport work.
- Read `references/configuration.md` for concrete setup and validation guidance.
- Read `references/final-explanation.md` before the final response for setup tasks.

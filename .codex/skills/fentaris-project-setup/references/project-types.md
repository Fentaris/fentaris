# Project Types

Use these shapes to guide setup questions and implementation.

Read `discovery.md` first when the user is still deciding how Fentaris should fit their workflow.

## Local Developer Proxy

Choose this when the user wants a quick local MCP proxy for one developer or a prototype.

- Use `fentaris init <name>` when available.
- Keep host on `127.0.0.1`, path `/mcp`, and the generated default port unless the user asks otherwise.
- Keep policies explicit even for demos. If temporary broad access is needed, label it as development-only in code comments or local docs.
- Validate with `fentaris check --offline` and, after starting the proxy, `fentaris doctor --runtime`.

## Internal Team Proxy

Choose this when a team shares multiple upstream MCP servers through one endpoint.

- Use stable server names because they become client-visible prefixes.
- Add users/groups and policies early.
- Add request identity mapping if the proxy receives headers such as user, tenant, trace, or environment.
- Use logging/audit hooks when the user wants observability.
- Ask whether team members connect from different machines. If yes, design the endpoint and host/network assumptions explicitly instead of leaving a laptop-local default.

## Production-Shaped Proxy

Choose this when the user mentions production, staging, governance, approvals, compliance, audit, or multi-tenant use.

- Bind publicly only when a deployment boundary is explicit.
- Configure auth, policies, logging, and secrets before exposure.
- Do not promise OAuth 2.1 support. Use API-key/header identity or an existing trusted auth boundary until OAuth 2.1 support exists.
- Keep endpoint path stable and configurable through `fentaris.json` or env vars.
- Do not run or invent deploy commands. State that Fentaris deploy is not available yet and the CLI is expected to add a smoother deploy flow later.

## Existing App Embedding

Choose this when the user already has a TypeScript service and wants Fentaris inside it.

- Add `@fentaris/core` integration in the app's existing structure.
- Prefer `fentaris(...)` as the application boundary.
- Fit startup/shutdown into the app's process model instead of adding a separate unrelated runtime.

## Custom Transport Or Extension

Choose this only when the user needs to connect a non-standard MCP source or custom exposure.

- Prefer built-in transport helpers first.
- Use extension contracts from `@fentaris/core/extensions` for custom integrations.
- Use advanced low-level proxy/transport APIs only when explicitly requested or required.

# Common Changes

## Add an Upstream MCP Server

- Preserve stable server names because they affect exposed tool names.
- Prefer a high-level `mcp("name", { transport })` declaration.
- Add display metadata when useful for logs and client diagnostics.
- Update policy to grant only the intended tools.

## Change Policy

- Prefer durable declarations with `policy(...)`, `group(...)`, and `user(...)`.
- Keep deny-by-default behavior intact.
- Use middleware for runtime checks based on request args, tenant, environment, or external state.
- Add or update tests for policy changes that affect access.

## Add Request Identity

- Resolve user, tenant, trace, and environment at the proxy edge.
- Keep identity mapping in one place so logging, policy, and upstream env injection use the same context.
- Avoid trusting headers unless the app is behind a known auth boundary.

## Add Middleware or Hooks

- Keep cross-cutting behavior near proxy setup unless the app already has a module convention.
- Use server/tool scoped middleware for targeted behavior.
- Avoid mutating request arguments unless the behavior is documented and tested.

## Add Secrets

- Use the project's Fentaris secret workflow or existing secret manager.
- Update secret manifests or env examples without committing secret values.
- Run secret diagnostics when available.

## Endpoint Changes

- Keep `path` stable for clients, usually `/mcp`.
- Prefer config/env changes over hardcoded host and port changes.
- Use `host: "0.0.0.0"` only when exposure is intentional and auth/policy are configured.

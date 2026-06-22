# Validation

Choose checks based on the files changed.

## Static Project Checks

- Run `fentaris check --offline` after changing generated project structure, config, or entrypoint code.
- Run `fentaris doctor` after changing config, auth directory, secrets wiring, package manager setup, or environment assumptions.
- Prefer `--non-interactive` when the installed CLI supports it and all required inputs are explicit.

## Runtime Checks

When endpoint behavior changes:

1. Start the app with the existing dev script or `fentaris dev`.
2. Run `fentaris doctor --runtime` if available.
3. Exercise the affected MCP operation or tool list when the project has a test client.

Do not leave dev servers running unnecessarily after validation unless the user asked for a running server.

## Package Checks

Run the existing package-manager scripts that map to the change:

- TypeScript or API changes: `typecheck` or `build`.
- Policy or middleware behavior: focused tests first, then broader tests if shared behavior changed.
- Docs/env example changes only: lint or formatting checks if present.

## Final Report

Report:

- What changed.
- Which commands ran.
- Any commands skipped and why.
- Residual deployment note when relevant: deploy is not available yet, but the CLI is expected to add a smoother deploy flow later.

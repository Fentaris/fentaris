# Documentation Impact Checklist

Run this checklist before finishing any code change.

## CLI

- New command, removed command, flag, option, output, or exit behavior: update `docs/reference/cli.mdx`.
- Project initialization behavior changed: update `docs/getting-started/quickstart.mdx` and `docs/reference/config-file.mdx`.
- Health check behavior changed: update `docs/reference/cli.mdx` and `docs/troubleshooting.mdx`.

## Config

- `fentaris.json` field added, removed, renamed, or default changed: update `docs/reference/config-file.mdx`.
- Runtime endpoint, port, path, package manager, entrypoint, or auth directory behavior changed: update quickstart and config reference.

## Environment

- Environment variable added, removed, renamed, or changed: update `docs/reference/environment-variables.mdx`.
- API key or credential behavior changed: update auth docs and troubleshooting.

## Public API

- Exported `@fentaris/core` API changed: run `pnpm docs:generate` and review `docs/reference-auto/`.
- User-facing TypeScript example changed: update the nearest guide and reference page.
- New docs example added: prefer high-level helpers before low-level classes.

## Behavior

- Auth, policy, routing, transport, observability, or error behavior changed: update the relevant concept page, guide, and troubleshooting entry.
- If a user would need to run a different command after the change, update the quickstart.

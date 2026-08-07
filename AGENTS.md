# AGENTS.md

## Cursor Cloud specific instructions

Fentaris is a pnpm monorepo (Node/TypeScript, ES modules). The published products live under `packages/*` (`@fentaris/core`, `@fentaris/cli`, `@fentaris/edge`, `@fentaris/approval-telegram`) and runnable demos under `examples/*`. There is no database, Docker, or external datastore — everything runs as local Node processes.

### Toolchain / Node version (non-obvious)
- The repo requires **Node >= 24** (`engines` in `package.json`; CI uses Node 24). The base VM ships an older `node` at `/exec-daemon/node` that sits early on `PATH`. To avoid it shadowing the right version, `~/.bashrc` prepends the nvm-managed Node 24 bin, so interactive shells resolve Node 24 and pnpm 11.18. If you spawn a non-interactive shell that skips `~/.bashrc` and hit a version mismatch, prefix `PATH` with `$HOME/.nvm/versions/node/v24.19.0/bin`.
- `engine-strict` is not set, so pnpm will not hard-fail on a wrong Node version — verify `node --version` reports v24 before debugging odd build behavior.

### Standard commands (root)
Lint/typecheck/build/test are the root scripts in `package.json` and mirror `.github/workflows/ci.yml`: `pnpm lint`, `pnpm typecheck`, `pnpm build`, and `pnpm -r test` (per-package Vitest). Tests are fully self-contained (no network/services required). See `README.md` for SDK/CLI usage.

### Running the product end-to-end
The canonical runnable proxy is `examples/team-governed-proxy` (follow its `README.md`). Non-obvious details:
- It is a **nested pnpm workspace** with its own lockfile that consumes the *published* `@fentaris/*` packages (not the workspace source), so its checks work independently of the root build. It is excluded from the root `pnpm-workspace.yaml` (`!examples/team-governed-proxy`) and Changesets `ignore` so version PRs cannot desync the root lockfile before those versions exist on npm.
- Start it with `pnpm dev` from that directory; it listens on `http://127.0.0.1:4100/mcp` (the CLI-generated default is port 4000).
- Governance/auth needs `FENTARIS_AUTH_KEY` exported in the same shell to unlock the local encrypted store, then provision an API key (`pnpm exec fentaris auth api-key add reader --generate --non-interactive`). The generated key is shown once. Drive the endpoint with `curl` or `npx @modelcontextprotocol/inspector` using the `x-fentaris-api-key` header.
- The `specification` upstream is a public remote MCP server; its `specification__*` tools only appear in `tools/list` when outbound network to `mcp.specification.website` is reachable. Local `workspace__*` tools always work offline.

# OAuth practical verification

Run from Node 24 after committing candidate changes and completing normal repository checks:

```sh
pnpm verify:oauth:practical
```

The runner allocates a new `install<N>` under `../installation_tests`, proves the source branch, commit, tree and `origin/dev` ancestry, builds and packs core/edge/CLI, installs those exact tarballs in a consumer project, then runs seven scenarios against local fixture authorization and MCP servers. Generated `dist`, dependency directories, TypeScript build metadata and the repository's ignored local agent tooling are excluded from the source identity comparison; tarball digests bind the actual installed candidate. Third-party versions are pinned: mcpjam CLI 5.12.1, SDK 8.20.0 and MCP protocol 2025-11-25.

| Scenario | Observable result |
|---|---|
| 01 upstream DCR / elicitation | URL consent completes; echo reports the upstream subject |
| 02 upstream pre-registered CLI login | `fentaris auth login --print-url` stores tokens reused after proxy restart |
| 03 upstream client credentials | Two users reuse one service token without elicitation |
| 04 inbound DCR headless | mcpjam conformance, negative checks, tools and session attack pass |
| 05 inbound pre-registered headless | Same checks using the fixture client registration |
| 06 inbound login / tools | Credentials from login authenticate tools/list and echo |
| 07 API-key fallback | mcpjam lists tools with `x-fentaris-api-key` on the same OAuth-enabled listener |

Explicit options:

```sh
node scripts/oauth-verification/run.mjs \
  --candidate /absolute/candidate \
  --branch codex/oauth-2-1-inbound-resource-server \
  --source-head <full-commit> --tree <full-tree> --target-dev <full-dev-commit> \
  --parent /absolute/installation_tests
```

`--attempt /absolute/new-attempt` supplies an exact attempt. It must not have an existing OAuth marker. `--scenario <id>` runs a focused scenario, but the overall verdict stays `BLOCKED` until the whole requirement matrix is covered. Attempts are never reused. No tests import product source; only the three test fixture utilities are materialized into the consumer, with recorded source and generated SHA-256 identities.

`REPORT.md` links command logs and maps scenarios to canonical OpenSpec requirements. `FAIL` and `BLOCKED` exit non-zero, including setup failures. Tokens, refresh tokens, authorization codes, API keys and the store key are inventoried and scanned throughout captured evidence. Credential files used by mcpjam are removed after use; encrypted stores may remain as evidence. A detected leak is redacted and fails the campaign. Cache and node_modules are operational dependencies rather than captured evidence. Processes close in each scenario; timeouts fail the campaign.

Run self-tests without starting the OAuth campaign:

```sh
pnpm test:oauth-verification
pnpm test:edge-verification
```

The separate SDK conformance gate is:

```sh
FENTARIS_MCPJAM=1 pnpm --filter @fentaris/core test test/conformance
```

For a manual conformance check against an already running fixture issuer and proxy:

```sh
npx -y @mcpjam/cli@5.12.1 oauth conformance \
  --url http://127.0.0.1:<port>/mcp --protocol-version 2025-11-25 \
  --registration dcr --auth-mode headless --verify-tools --conformance-checks
```

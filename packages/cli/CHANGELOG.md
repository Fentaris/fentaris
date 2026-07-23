# @fentaris/cli

## 1.4.2

### Patch Changes

- Updated dependencies [569938f]
  - @fentaris/core@2.3.1

## 1.4.1

### Patch Changes

- e41e270: Make `doctor --runtime` probe the already-running MCP endpoint without spawning a
  second development server or reporting the expected listening port as a conflict.
- 6883648: Generate pnpm projects as self-contained workspace roots and allow the `esbuild`
  postinstall required by `tsx`, preventing installs from attaching to an ancestor
  workspace or stopping for build approval.
- 0bebd92: Generate projects with compatible dependency ranges instead of floating `latest`
  versions, and label the default allow-all policy as local-development-only in
  both source code and project documentation.

## 1.4.0

### Minor Changes

- e46a7ba: Add agent-native MCP tool discovery and auth inspection. Core now validates `cli.mcpAccounts` selectors and exposes `AgentToolDiscoveryService` with stable JSON envelopes, policy-filtered effective tool listing, search, detail, schema inspection, account status, login affordances, pagination, and response budgeting. The CLI adds `fentaris tools list/search/get/schema` and `fentaris tools auth list/status/login`.

### Patch Changes

- Updated dependencies [e46a7ba]
- Updated dependencies [e39be45]
- Updated dependencies [b81f061]
  - @fentaris/core@2.3.0

## 1.3.0

### Minor Changes

- 8d844aa: Add machine-readable project diagnostics with `fentaris check --json` for CI and agent-driven workflows.
- 3d0ca93: Add a guided `fentaris auth` menu, interactive API-key setup with user discovery and redacted confirmation, and auth command support for SDK-only projects.

### Patch Changes

- 43998a5: Load `FENTARIS_AUTH_KEY` from the discovered project `.env` for local secrets and API-key commands before prompting.
- Updated dependencies [f355a29]
  - @fentaris/core@2.2.0

## 1.2.1

### Patch Changes

- 673680d: Replace generated project guidance for the unavailable upgrade command with package-manager update instructions.
- Updated dependencies [f46bdad]
  - @fentaris/core@2.1.2

## 1.2.0

### Minor Changes

- 5825770: `fentaris init` now pins `@fentaris/core` to a known version range (currently `^2.0.0`) instead of `latest`. This makes local SDK/CLI integration tests deterministic and prevents a generated project from silently running a different core than the one this CLI was released against. Pass `--core-version <range>` to override the default; semver ranges, dist tags, and `workspace:*`/`file:` references are all accepted.
- f2571ec: Allow `fentaris secrets` commands to run in SDK-only projects by discovering `package.json` projects that depend on `@fentaris/core`, including optional `package.json` metadata and `--entrypoint` support for manifest generation.

### Patch Changes

- 99b9900: Fix `fentaris init --non-interactive` by supporting explicit scaffold inputs, including `--package-manager`, by failing early when the project name is missing, and by reporting unavailable explicit package managers before install runs.
- 67f1cc1: Report a warning when `@fentaris/core` is declared but missing from `node_modules` so `fentaris doctor` shows the install step by default.

## 1.1.1

### Patch Changes

- 4bad9fd: Build CLI output during local package installs so the `fentaris` binary is linked.
- 80d865a: Accept empty Enter at the init package-manager prompt as the displayed default choice.
- Updated dependencies [e889b9d]
- Updated dependencies [40c6e9a]
  - @fentaris/core@2.1.1

## 1.1.0

### Minor Changes

- 3874e97: Add `fentaris auth api-key` commands for storing, listing, generating, and removing local downstream API keys, with hashed API-key management helpers on the local secrets backend.

### Patch Changes

- Updated dependencies [5a319c2]
- Updated dependencies [3874e97]
- Updated dependencies [bde0b12]
  - @fentaris/core@2.1.0

## 1.0.0

### Major Changes

- ef570e8: Rename remaining legacy configuration and secrets provider identifiers to Fentaris.

### Minor Changes

- 93f9816: Add global `--non-interactive` support for automation and ensure CLI prompts release stdin after completion so successful commands return to the shell.

### Patch Changes

- Updated dependencies [ef570e8]
  - @fentaris/core@2.0.0

## 0.6.0

### Minor Changes

- 05425ab: Harden proxy policy enforcement by denying unconfigured proxy access by default, making policy denies terminal before hooks or middleware, re-filtering tool discovery after hooks, enforcing policy-attached rate limiters automatically, and reporting open-policy CLI diagnostics.

### Patch Changes

- e81b53e: Harden local secrets handling with stdin secret input, truthful unset reporting, versioned PBKDF2 credential storage, owner-only credential file permissions, and improved manifest diagnostics.
- bb4b69c: Harden downstream transport authentication and upstream HTTP networking defaults.

  HTTP Streamable and SSE exposure transports now bind session continuations to the authenticated identity, SSE `/messages` requests resolve identity before accepting posts, stdio exposure fails when identity is required but unavailable, and HTTP/SSE listeners bind to `127.0.0.1` unless a host is configured. Upstream HTTP transports now avoid arbitrary env-to-header forwarding and block loopback, link-local, private, and metadata URLs unless explicitly allowed.

- 703c43f: Improve the interactive `fentaris secrets set` flow with arrow-key select menus, scoped subject id selection, and no duplicated credential scope heading.
- Updated dependencies [05425ab]
- Updated dependencies [f4af3c4]
- Updated dependencies [e81b53e]
- Updated dependencies [bb4b69c]
- Updated dependencies [190f600]
- Updated dependencies [0ee5a94]
- Updated dependencies [06c68bf]
  - @fentaris/core@1.0.0

## 0.5.1

### Patch Changes

- a6cdb20: Release the interactive secrets prompt fixes shipped from dev, including isolated masked input handling, updated runtime prompt plumbing, and CLI docs/test coverage.

## 0.5.0

### Minor Changes

- ee6cee0: Add a guided interactive setup flow for `fentaris secrets set` with manifest reference selection, scope selection, a redacted review step, confirmation before writing, and clearer next-step output.

### Patch Changes

- 9c3b15c: Make git initialization optional during `fentaris init` and add `--skip-git` for file-only scaffolding.

## 0.4.1

### Patch Changes

- 41ef29b: Add clearer ANSI coloring to CLI help, error, command, option, and diagnostic output.
- 5579295: Show compact doctor and check output with a summary line and issues only by default, add `--verbose`, and check only the configured package manager instead of every supported manager.

## 0.4.0

### Minor Changes

- 7f80b34: Remove the legacy `fentaris auth` command group.

  Use `fentaris init` to create local credentials and `fentaris secrets` commands to manage encrypted credentials.

### Patch Changes

- a2dd60f: Allow CLI option values supplied after value-taking flags or with `--option=value` to start with a dash.
- f0ab65b: Point doctor guidance for missing encrypted credentials to `fentaris secrets set` instead of project initialization.
- fdc7b15: Align CLI help and error output with contextual command usage, parser-style syntax errors, and distinct exit codes.
- Updated dependencies [8a5a563]
  - @fentaris/core@0.7.0

## 0.3.3

### Patch Changes

- Updated dependencies [e308af0]
  - @fentaris/core@0.6.2

## 0.3.2

### Patch Changes

- Updated dependencies [97ed1cb]
  - @fentaris/core@0.6.1

## 0.3.1

### Patch Changes

- 4b49d11: Add root-level help and version flags.

## 0.3.0

### Minor Changes

- c8023e5: Add cloud-ready local secrets management with a `SecretsBackend` abstraction, `fentaris secrets list`, `manifest`, `doctor`, and `unset` commands, plus a committable `.fentaris/secrets.manifest.json` schema.

### Patch Changes

- 8e20832: Fix secrets manifest generation and local secrets presence checks.

  Generated projects now allow `.fentaris/secrets.manifest.json` to be committed while keeping local secret files ignored, and `fentaris secrets manifest` creates the auth directory before writing the manifest. The local secrets backend no longer reports arbitrary user-scoped credentials as present when a user only has API keys.

- Updated dependencies [2a952cf]
- Updated dependencies [c8023e5]
- Updated dependencies [8e20832]
  - @fentaris/core@0.6.0

## 0.2.3

### Patch Changes

- 69bf7c6: Ignore ambient FENTARIS_AUTH_KEY values when checking projects without local credential stores.
- 56b520f: Load the generated project `.env` file before running `fentaris dev` so local encrypted credentials can be decrypted from quickstart projects.
- cb82ee3: Simplify the generated `fentaris init` project to start without demo auth, policies, profiler hooks, or extra upstream servers.
- Updated dependencies [192dd8b]
  - @fentaris/core@0.5.1

## 0.2.2

### Patch Changes

- 1f53902: Allow `fentaris build` to continue when a generated project's local `.env` file is absent and secrets are supplied through the runtime environment.
- 83b66c6: Generate a ready-to-use `.env` file during `fentaris init` instead of requiring users to copy `.env.example`.

## 0.2.1

### Patch Changes

- ced04e2: Improve the generated project and runtime DX: `fentaris()` now picks up local project defaults, deferred MCP declarations can satisfy policy validation before start, scoped middleware receives contextual types, and a concise `rateLimit({ max, per })` helper is available.

  `fentaris dev` now runs the configured entrypoint directly, loads `.env`, and forwards termination signals to the child process.

- Updated dependencies [ced04e2]
  - @fentaris/core@0.5.0

## 0.2.0

### Minor Changes

- 7eec822: Expand `fentaris doctor` with project discovery, JSON config validation, package/auth/network diagnostics, safe fixes, JSON output, and opt-in runtime probing.

  Ensure strict project checks honor the runtime auth key and doctor validates/fixes `.gitignore` entries for custom auth directories.

### Patch Changes

- Updated dependencies [ab74382]
- Updated dependencies [f2d29f2]
- Updated dependencies [fa23cad]
- Updated dependencies [683ae94]
  - @fentaris/core@0.4.0

## 0.1.5

### Patch Changes

- Updated dependencies [be8e9e1]
- Updated dependencies [a2cd723]
  - @fentaris/core@0.3.0

## 0.1.4

### Patch Changes

- d3518f8: Add `@types/node` to generated project dev dependencies so the default TypeScript template recognizes Node globals such as `process`.
- Updated dependencies [de87ca4]
- Updated dependencies [94bfaf9]
  - @fentaris/core@0.2.0

## 0.1.3

### Patch Changes

- c68cf8a: Fix CLI startup when the installed `fentaris` bin resolves through a symlink.

## 0.1.2

### Patch Changes

- Updated dependencies [1a37457]
  - @fentaris/core@0.1.1

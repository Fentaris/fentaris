# @fentaris/cli

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

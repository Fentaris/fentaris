# @fentaris/edge

## 0.3.1

### Patch Changes

- da1a47a: Recover stale local authority locks and support an explicit cross-platform Edge state directory.
- 74a7f69: Preserve an explicitly configured Edge state directory in persistent launchd and systemd services.
- 147f945: Keep local Edge control sockets within platform path limits and clean up the persistent agent when control startup fails.
- 64813bd: Treat rejected and revoked Edge credentials as terminal, stop reconnect loops, and direct operators to join the device again.
- 6599d72: Redact Telegram bot tokens from transport error logs and include operational Edge documentation in the published package.
- 0997001: Publish workload capability manifests during desired-state reconciliation so Edge tools can be discovered and authorized before their first downstream call.
- Updated dependencies [da1a47a]
- Updated dependencies [4836bf7]
- Updated dependencies [64813bd]
- Updated dependencies [eb7e639]
  - @fentaris/core@3.0.1

## 0.3.0

### Minor Changes

- e327f03: Add persistent service operation, protocol-v2 presence reporting, local lifecycle control, and legacy `fentaris-edge` command compatibility.
- c474ee6: Add the integrated Edge device authority, authorization and enrollment routes, protected local approval channel, automatic desired-state reconciliation, gateway capability bridge, lifecycle health, CLI approval workflow, and real-agent loopback support.
- 4d8d03c: Add immutable, consent-gated managed MCP installation on Edge devices with protocol-v3 lifecycle correlation, protected local operations, health and inventory state, recovery, rollback, and safe cleanup.

### Patch Changes

- Updated dependencies [e327f03]
- Updated dependencies [43e4fdd]
- Updated dependencies [1ea9154]
- Updated dependencies [c474ee6]
- Updated dependencies [4d8d03c]
  - @fentaris/core@3.0.0

## 0.2.2

### Patch Changes

- Updated dependencies [569938f]
  - @fentaris/core@2.3.1

## 0.2.1

### Patch Changes

- Updated dependencies [e46a7ba]
- Updated dependencies [e39be45]
- Updated dependencies [b81f061]
  - @fentaris/core@2.3.0

## 0.2.0

### Minor Changes

- f355a29: Add governed edge execution targets, including device enrollment, local setup grants, session-pinned dispatch, capability discovery, and the edge workload runtime.

### Patch Changes

- Updated dependencies [f355a29]
  - @fentaris/core@2.2.0

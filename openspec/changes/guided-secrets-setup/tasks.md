## 1. Requirement Model and Discovery

- [ ] 1.1 Extend manifest types, parsing, serialization, equality, and backward compatibility for source metadata and API-key requirements
- [ ] 1.2 Expand entrypoint scanning for scoped local/env credentials, API-key declarations, counts, and unsupported custom JSON sources
- [ ] 1.3 Update manifest, list, and doctor flows to consume the richer requirement model

## 2. Guided CLI Setup

- [ ] 2.1 Add the `fentaris secrets setup` command contract, flags, help, and routing
- [ ] 2.2 Implement interactive review, hidden external-value collection, local key bootstrap, API-key generation, and idempotent writes
- [ ] 2.3 Implement dry-run, non-interactive preflight, canonical JSON envelopes, next actions, and one-time generated-key output

## 3. Runtime Credential Readiness

- [ ] 3.1 Collect and deduplicate declared runtime credential sources with sanitized usage metadata
- [ ] 3.2 Validate sources before `start()` and first `listen()` and raise aggregated `FENTARIS_CREDENTIALS_UNAVAILABLE` errors
- [ ] 3.3 Add core tests for successful readiness, missing env/local values, wrong keys, aggregation, sanitization, and no-listener failure

## 4. Verification and Release

- [ ] 4.1 Add CLI tests for discovery, legacy manifests, guided setup, reruns, dry-run, JSON, non-interactive failures, precedence, permissions, and redaction
- [ ] 4.2 Update CLI, environment, governance, troubleshooting, and generated API documentation
- [ ] 4.3 Add core-major and CLI-minor Changeset entries and validate the OpenSpec change
- [ ] 4.4 Run focused and full checks and verify the workflow against `../presentation`

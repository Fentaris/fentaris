# secrets-cli-storage-security Specification

## Purpose
TBD - created by archiving change harden-secrets-cli-and-storage. Update Purpose after archive.
## Requirements
### Requirement: Safe non-TTY secret input

The CLI SHALL NOT echo secret values through fallback line prompts when stdin or stdout is non-interactive.

#### Scenario: Secret prompt in CI

- **WHEN** a command needs a secret value and stdin or stdout is not a TTY
- **THEN** the CLI fails with guidance for a safe input method or reads only from an explicitly requested safe source

### Requirement: Argv secret risk mitigation

The CLI SHALL provide non-argv input methods for secret values and warn when sensitive values are supplied through argv options.

#### Scenario: Value supplied through stdin

- **WHEN** a user runs a secrets command with `--value-stdin`
- **THEN** the CLI reads the secret value from stdin without requiring the value to appear in process arguments

### Requirement: Accurate unset reporting

Secret removal SHALL report whether a stored secret was actually removed.

#### Scenario: Missing secret removal

- **WHEN** `secrets unset` targets a missing ref, scope, or store entry
- **THEN** the CLI reports that nothing was removed instead of printing unconditional success

### Requirement: Versioned stretched credential encryption

Local encrypted credential storage SHALL use a versioned format with KDF metadata and a stretched key derivation function for new writes.

#### Scenario: Legacy store read

- **WHEN** an existing store encrypted with the legacy SHA-256 derivation is read with the correct key
- **THEN** the backend can decrypt it and preserve or migrate the data safely

### Requirement: Owner-only credential file permissions

Local encrypted credential files SHALL be written with owner-only permissions on Unix platforms.

#### Scenario: Credential file write

- **WHEN** the local backend writes `credentials.enc.json` on Unix
- **THEN** the resulting file mode is restricted to the owner

### Requirement: Secrets doctor key parity

`secrets doctor` SHALL support the same explicit auth key input path as other secrets commands.

#### Scenario: Doctor with explicit key

- **WHEN** a user runs `secrets doctor --key <value>`
- **THEN** the doctor command validates the store using that key instead of requiring only `FENTARIS_AUTH_KEY`

### Requirement: Scoped manifest secret scanning

The manifest scanner SHALL detect credential declarations with user, group, and default scopes, including supported `credentialEnv` patterns.

#### Scenario: Scoped credential in manifest

- **WHEN** a manifest source declares a group-scoped credential
- **THEN** the scanner reports the correct credential ref and scope

### Requirement: Friendly malformed manifest errors

Secrets commands SHALL wrap malformed manifest JSON errors with actionable CLI messages.

#### Scenario: Invalid manifest JSON

- **WHEN** a secrets command reads an invalid manifest JSON file
- **THEN** the CLI reports the manifest path and parse problem without exposing a raw `SyntaxError` stack by default

### Requirement: Single local credential helper path

The CLI SHALL avoid duplicate unused local credential helper implementations that can drift from the active backend.

#### Scenario: Local auth helpers are maintained

- **WHEN** maintainers inspect local credential operations
- **THEN** there is one active implementation path or duplicate helpers are covered by compatibility tests


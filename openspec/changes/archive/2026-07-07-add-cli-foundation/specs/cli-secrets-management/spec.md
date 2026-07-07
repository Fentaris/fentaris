## ADDED Requirements

### Requirement: Top-level secrets set
The CLI SHALL provide `fentaris secrets set` as the primary workflow for storing local encrypted credentials used by Fentaris projects.

#### Scenario: Set default credential
- **WHEN** a developer runs `fentaris secrets set github.token`
- **THEN** the CLI prompts for the secret value and stores it in the project's encrypted local credential store as a default credential

### Requirement: Subject-scoped secrets
The `fentaris secrets set` command SHALL support storing credentials for a specific user or group.

#### Scenario: Set user credential
- **WHEN** a developer runs `fentaris secrets set github.token --user alice`
- **THEN** the CLI stores the credential for user `alice` without printing the raw value

#### Scenario: Set group credential
- **WHEN** a developer runs `fentaris secrets set github.token --group support`
- **THEN** the CLI stores the credential for group `support` without printing the raw value

### Requirement: Local auth compatibility
The secrets workflow SHALL use the same encrypted local auth storage format supported by `FentarisAuth.local`.

#### Scenario: Proxy resolves stored secret
- **WHEN** a developer stores a credential with `fentaris secrets set`
- **THEN** a project using `FentarisAuth.local` can resolve that credential according to existing Fentaris credential precedence

### Requirement: Safe secret output
The CLI SHALL redact secret values in all normal terminal output.

#### Scenario: Secret stored
- **WHEN** `fentaris secrets set github.token` succeeds
- **THEN** the CLI confirms the credential reference was stored without printing the secret value

### Requirement: Legacy auth helper preservation
Existing local auth helper behavior SHALL remain available or be mapped to equivalent new commands during the CLI foundation change.

#### Scenario: Existing auth init workflow
- **WHEN** a developer uses the existing local auth initialization workflow
- **THEN** the CLI still supports creating Fentaris local auth files compatible with current projects

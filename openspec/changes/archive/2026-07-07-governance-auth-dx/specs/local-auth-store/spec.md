## ADDED Requirements

### Requirement: Unified local auth configuration
The system SHALL provide a single local auth configuration object that manages encrypted credentials and upstream auth bindings together.

#### Scenario: Load local auth directory
- **WHEN** a developer configures `FentarisAuth.local({ dir, key })`
- **THEN** Fentaris loads encrypted credentials and non-sensitive upstream auth bindings from the configured directory

#### Scenario: Missing local auth file
- **WHEN** the configured local auth directory is missing required files
- **THEN** Fentaris reports a clear configuration error before serving requests

### Requirement: Encrypted credentials file
The system SHALL store user API keys and credential values in encrypted local JSON.

#### Scenario: Decrypt credentials
- **WHEN** Fentaris starts with a valid local auth key
- **THEN** Fentaris decrypts the credentials file and validates its user, group, and default credential sections

#### Scenario: Invalid decryption key
- **WHEN** Fentaris starts with an invalid local auth key
- **THEN** Fentaris fails closed and does not expose the proxy

### Requirement: Non-sensitive upstream auth bindings file
The system SHALL store upstream auth binding rules in a non-sensitive local JSON file.

#### Scenario: Load upstream binding
- **WHEN** an upstream auth binding maps a server to a credential reference and auth type
- **THEN** Fentaris validates the binding without requiring decrypted credential values in that file

#### Scenario: Invalid upstream binding
- **WHEN** an upstream auth binding references an unsupported auth type or missing required field
- **THEN** Fentaris reports a configuration error before serving requests

### Requirement: Local auth file separation
The system SHALL keep secret values separate from non-sensitive auth binding declarations.

#### Scenario: Review upstream auth safely
- **WHEN** a developer opens the upstream auth binding file
- **THEN** the file contains credential references and header/bearer/env instructions but no raw credential values

#### Scenario: Rotate secret value
- **WHEN** a developer rotates a credential value in the encrypted credentials file
- **THEN** the upstream auth binding file does not need to change if the credential reference stays the same

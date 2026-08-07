## ADDED Requirements

### Requirement: Local auth source readiness
Declared local auth sources SHALL be readable before the runtime begins serving requests.

#### Scenario: Missing local store
- **WHEN** runtime configuration declares a local JSON credential source and its file does not exist
- **THEN** runtime startup fails with a sanitized credential-readiness error

#### Scenario: Wrong local encryption key
- **WHEN** the configured local store cannot be decrypted with the available key
- **THEN** runtime startup fails without exposing the key, ciphertext, or decrypted values

#### Scenario: Project does not declare credentials
- **WHEN** runtime configuration declares no credential sources
- **THEN** no encryption key or local credential store is required for startup

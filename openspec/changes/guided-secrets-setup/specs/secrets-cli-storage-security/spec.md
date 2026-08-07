## ADDED Requirements

### Requirement: Complete secret requirement discovery
The CLI SHALL discover local JSON sources, environment sources, scoped credentials, and declared Fentaris user API keys from the project entrypoint.

#### Scenario: Supported declarations are scanned
- **WHEN** an entrypoint uses `credential`, `credentialJson`, or `credentialEnv` in default, group, user, or API-key declarations
- **THEN** the generated manifest records the requirement, scope, source kind, and API-key count without storing a value

#### Scenario: Existing version 1 manifest
- **WHEN** the CLI reads a version 1 manifest without source or API-key metadata
- **THEN** it treats existing reference entries as local credentials and remains compatible

#### Scenario: Unsupported custom local source
- **WHEN** a credential uses a custom file or a path that the standard local backend cannot provision
- **THEN** discovery reports it as requiring manual setup instead of writing to the wrong location

### Requirement: Guided complete setup
The CLI SHALL provide `fentaris secrets setup` to review and provision every missing supported project requirement.

#### Scenario: First interactive setup
- **WHEN** a user confirms setup for a project with missing local API keys and external credentials
- **THEN** the CLI creates the project encryption key when needed, generates local API keys, prompts invisibly for external values, and reports generated client keys once

#### Scenario: Setup rerun
- **WHEN** all requirements are already configured
- **THEN** setup performs no writes and does not regenerate API keys

#### Scenario: Dry run
- **WHEN** setup runs with `--dry-run`
- **THEN** it reports planned generation, prompts, and unsupported requirements without creating values or modifying files

### Requirement: Scriptable setup is atomic before provisioning
Non-interactive and JSON setup SHALL validate that all non-generatable values are already available before generating or writing anything.

#### Scenario: Missing external value in non-interactive mode
- **WHEN** setup runs non-interactively and an external value is missing
- **THEN** it exits unsuccessfully with `SECRETS_SETUP_INCOMPLETE`, makes no changes, and provides concrete next actions

#### Scenario: Successful JSON setup
- **WHEN** setup runs with `--json --yes` and every non-generatable value is available
- **THEN** it returns the canonical success envelope and includes newly generated API keys exactly once

#### Scenario: Sensitive output
- **WHEN** setup emits human or JSON output
- **THEN** raw external values, encryption keys, and decrypted stored values are never printed

## ADDED Requirements

### Requirement: Project check command
The CLI SHALL provide `fentaris check` to validate the current Fentaris project.

#### Scenario: Valid project
- **WHEN** a developer runs `fentaris check` inside a valid generated Fentaris project
- **THEN** the CLI validates project config, expected files, package metadata, auth references, and proxy entrypoint configuration

### Requirement: MCP validation
The `fentaris check` command SHALL be able to validate configured MCP upstreams and discover tools when connectivity checks are enabled.

#### Scenario: MCP upstream reachable
- **WHEN** a configured MCP upstream can be reached during `fentaris check`
- **THEN** the CLI reports the upstream as reachable and includes discovered tool information

#### Scenario: MCP upstream unreachable
- **WHEN** a configured MCP upstream cannot be reached during `fentaris check`
- **THEN** the CLI reports the upstream as failed without hiding other check results

### Requirement: Check modes
The `fentaris check` command SHALL support modes that separate local-only validation from stricter validation.

#### Scenario: Offline check
- **WHEN** a developer runs `fentaris check --offline`
- **THEN** the CLI performs static local validation without attempting network or MCP connectivity

#### Scenario: Strict check
- **WHEN** a developer runs `fentaris check --strict` and warnings are present
- **THEN** the CLI exits with a failing status

### Requirement: Doctor command
The CLI SHALL provide `fentaris doctor` to validate the local machine and runtime environment independently of a Fentaris project.

#### Scenario: Doctor outside project
- **WHEN** a developer runs `fentaris doctor` outside a Fentaris project
- **THEN** the CLI checks local prerequisites and reports results without requiring project metadata

### Requirement: Doctor checks
The `fentaris doctor` command SHALL check supported local prerequisites including Node version, package manager availability, git availability, Docker availability, port availability where relevant, and CLI writable directories.

#### Scenario: Missing Docker
- **WHEN** Docker is not available
- **THEN** `fentaris doctor` reports Docker as a warning for future Docker/deploy workflows rather than a mandatory blocker for local dev

### Requirement: Doctor fixes
The `fentaris doctor` command SHALL ask for confirmation before attempting each supported automatic fix.

#### Scenario: Multiple fixable issues
- **WHEN** `fentaris doctor --fix` detects multiple fixable issues
- **THEN** the CLI asks about each fix one at a time in order and only applies fixes the developer approves

### Requirement: Health output style
Health commands SHALL use ordered, colored, sectioned output with clear pass, warning, and failure states.

#### Scenario: Mixed health results
- **WHEN** `fentaris doctor` or `fentaris check` reports passes, warnings, and failures
- **THEN** the terminal output groups them by concern and makes the final status clear

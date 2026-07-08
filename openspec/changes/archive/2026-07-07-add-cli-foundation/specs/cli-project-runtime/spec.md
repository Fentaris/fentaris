## ADDED Requirements

### Requirement: Local dev command
The CLI SHALL provide `fentaris dev` to run the current Fentaris project locally.

#### Scenario: Dev inside project
- **WHEN** a developer runs `fentaris dev` inside a generated Fentaris project
- **THEN** the CLI starts the project and exposes the proxy at the configured local endpoint

#### Scenario: Dev outside project
- **WHEN** a developer runs `fentaris dev` outside a Fentaris project
- **THEN** the CLI exits with a clear error explaining that no Fentaris project was found

### Requirement: Project discovery
The CLI SHALL discover Fentaris project metadata from the current directory or an ancestor directory before running project-scoped commands.

#### Scenario: Command in nested source directory
- **WHEN** a developer runs `fentaris dev` from `my-app/src`
- **THEN** the CLI resolves the project root and runs the project from that root

### Requirement: Local build artifact
The CLI SHALL provide `fentaris build` to create a local deterministic build artifact without deploying it.

#### Scenario: Build succeeds
- **WHEN** a developer runs `fentaris build` inside a valid Fentaris project
- **THEN** the CLI validates the project, compiles or packages the configured entrypoint, and writes build output under `.fentaris/build`

### Requirement: Build output description
The CLI SHALL report the build output path and runtime entrypoint after a successful build.

#### Scenario: Build summary
- **WHEN** `fentaris build` succeeds
- **THEN** the CLI prints the output directory and the entrypoint that a future deploy or Docker workflow can consume

### Requirement: Deploy excluded
The CLI SHALL not expose a working `fentaris deploy` implementation as part of this change.

#### Scenario: Developer runs deploy
- **WHEN** a developer runs `fentaris deploy`
- **THEN** the CLI reports that deploy is not available yet and points to build output as the current packaging step

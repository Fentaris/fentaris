## ADDED Requirements

### Requirement: Integrated Edge control-plane configuration
Fentaris SHALL expose a supported explicit configuration for enabling the integrated Edge control plane, selecting local or managed operation, defining a non-conflicting base path and canonical public origin, locating protected local state, and supplying managed adapters without requiring users to construct low-level gateway objects.

#### Scenario: Minimal local configuration is valid
- **WHEN** a single-process application enables local integrated Edge with a valid protected auth directory and loopback public origin
- **THEN** configuration resolves documented secure defaults for endpoint paths, token lifetimes, request limits, and local adapters

#### Scenario: Managed configuration is valid
- **WHEN** a deployment enables managed integrated Edge with every required durable adapter, authorization boundary, public origin, and distributed channel contract
- **THEN** validation accepts the configuration without substituting local reference adapters

#### Scenario: Edge configuration is absent
- **WHEN** an existing application has no integrated Edge configuration
- **THEN** its configuration, exposure, lifecycle, and MCP behavior remain unchanged

### Requirement: Edge public-origin and route validation
Fentaris MUST validate the canonical Edge public origin and base path before startup and MUST NOT derive a security-sensitive enrollment or gateway origin from untrusted Host or forwarded headers.

#### Scenario: Non-loopback origin is insecure
- **WHEN** an integrated Edge public origin uses HTTP or WS for a non-loopback host
- **THEN** validation rejects it with a diagnostic requiring HTTPS and WSS

#### Scenario: Trusted reverse proxy is configured
- **WHEN** an application terminates TLS at an explicitly trusted reverse proxy and declares its canonical HTTPS public origin
- **THEN** Fentaris emits authorization, verification, enrollment, and gateway URLs from that configured origin

#### Scenario: Base path is invalid or conflicting
- **WHEN** the Edge base path is empty, malformed, root-wide, or overlaps another Fentaris-owned route
- **THEN** validation rejects startup with a stable path-specific diagnostic

### Requirement: Edge adapter and state validation
Fentaris SHALL validate adapter completeness, diagnostics, durability, atomicity, distribution, writable state location, owner protections, and secret references for the selected Edge control-plane mode.

#### Scenario: Local state directory is unsafe
- **WHEN** the configured local Edge state is outside the project auth boundary, world-accessible, committed, or cannot enforce owner-only permissions
- **THEN** validation rejects initialization without writing credentials or enrollment state

#### Scenario: Managed mode uses reference adapters
- **WHEN** managed or multi-instance mode receives single-process reference stores or an instance-local active channel map
- **THEN** validation reports an error instead of presenting the control plane as production-ready

#### Scenario: Sensitive value is embedded in configuration
- **WHEN** configuration contains a raw signing key, token secret, device credential, or other protected Edge value
- **THEN** validation rejects the value and directs the user to Fentaris protected secret or adapter configuration without rendering it

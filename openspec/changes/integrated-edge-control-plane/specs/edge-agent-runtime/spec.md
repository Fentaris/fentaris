## ADDED Requirements

### Requirement: Integrated application control-plane interoperability
The Edge agent SHALL complete join, authorization polling, enrollment, token refresh, gateway connection, desired-state reconciliation, disconnect, and revocation against an integrated Fentaris application control plane using the negotiated public base URL and existing versioned Edge protocol without application-specific client code.

#### Scenario: Edge joins an integrated application
- **WHEN** a user runs the supported Edge join command with an integrated application's Edge base URL and completes approval
- **THEN** the agent enrolls, authenticates the gateway, receives current eligible desired state, performs local setup, and reports readiness through the standard Edge protocol

#### Scenario: Access token expires
- **WHEN** the agent's access token is expired but its rotating refresh credential remains valid and unrevoked
- **THEN** the agent obtains a new bounded token set without repeating device enrollment or exposing credentials in command output

#### Scenario: Integrated application rejects the agent version
- **WHEN** no mutually supported Edge protocol version can satisfy the assigned deployments
- **THEN** the agent remains non-ready and reports a stable upgrade-required diagnostic without attempting workload execution

### Requirement: Server-confirmed revocation
The Edge agent SHALL treat successful remote revocation as authoritative and SHALL clear local device identity, protected credentials, grants, and workload state only according to the existing revocation safety contract.

#### Scenario: Enrolled Edge revokes itself
- **WHEN** the user runs the supported revoke command while the integrated control plane is reachable
- **THEN** the control plane invalidates the device before the agent clears local identity and stops reconnecting

#### Scenario: Remote revocation cannot be confirmed
- **WHEN** a revoke request cannot reach or authenticate to the integrated control plane
- **THEN** the agent reports the failure and does not falsely claim that server-side authorization was removed

## ADDED Requirements

### Requirement: Installation-aware setup sequencing
Edge setup reconciliation SHALL resolve installation readiness before compiling local runtime grants into a launch plan, while deployments without an installation recipe SHALL retain existing setup behavior.

#### Scenario: Deployment requires managed installation
- **WHEN** desired state assigns an MCP with an installation recipe to an eligible Edge
- **THEN** the Edge completes preflight, required approval, installation, and verification before configuring runtime inputs or starting the MCP

#### Scenario: Deployment has no installation recipe
- **WHEN** desired state assigns an MCP whose executable is expected to exist and no installation recipe is declared
- **THEN** the Edge performs the existing executable policy, setup, and launch validation without introducing an installation mutation

#### Scenario: Installation is not ready
- **WHEN** installation is approval-required, installing, incompatible, blocked, or failed
- **THEN** launch-plan compilation remains unavailable and setup reports the corresponding bounded next action

### Requirement: Installation source setup confidentiality
Installation recipes SHALL reference private-source credentials and local artifact paths through typed setup references whose resolved values remain on the Edge.

#### Scenario: Private repository credential is supplied
- **WHEN** a local operator completes a secret setup field used to fetch a private installation source
- **THEN** the Edge resolves it only for the bounded fetch operation and does not serialize it into desired state, lifecycle reports, or installer arguments visible to the control plane

#### Scenario: Local enterprise artifact is selected
- **WHEN** an installation source uses an approved local file or folder setup field
- **THEN** the Edge applies canonical path containment and grants only the access declared by the installation recipe

### Requirement: Independent installation and workload consent
Installation approval, executable recipe approval, and sensitive local grant approval SHALL remain independently revocable and SHALL each block dependent deployment readiness when absent.

#### Scenario: Installer is approved but folder access is denied
- **WHEN** installation succeeds but the local operator denies a required runtime folder grant
- **THEN** the installation remains verified while the deployment is blocked from starting

#### Scenario: Installation approval is revoked
- **WHEN** the local operator revokes approval for the active installation recipe
- **THEN** the Edge stops dependent workloads and does not reinstall or restart them until renewed approval is recorded


export const EDGE_REQUIREMENTS = Object.freeze({
  "integrated-edge-control-plane": Object.freeze([
    "Integrated control-plane exposure", "Explicit device-code authorization", "Device-bound enrollment and gateway authentication",
    "Automatic application-owned desired state", "Reconciliation ordering and dispatch safety",
    "Protected single-process mode and managed adapters", "Confidential and bounded control-plane responses",
  ]),
  "edge-agent-runtime": Object.freeze([
    "Edge package and operator CLI", "Device-bound enrollment identity", "Authenticated outbound edge channel",
    "Versioned desired-state reconciliation", "Session-isolated MCP process lifecycle", "Governed local process execution",
    "Complete MCP operation forwarding", "Edge disconnect and reconnect behavior", "Capability manifest reporting and caching",
    "Local revocation overrides cloud state", "Edge observability and secret redaction", "Edge gateway adapter contracts",
    "Integrated application control-plane interoperability", "Server-confirmed revocation",
    "Installation-aware desired-state reconciliation", "Durable deployment lifecycle attempts",
    "Installation lifecycle status and controls", "Installation telemetry and health",
    "Attributed device metadata and presence reporting",
  ]),
  "edge-runtime-setup": Object.freeze([
    "Typed runtime references", "MCP setup schema", "Supported setup field types", "Cloud target unresolved-input validation",
    "Cloud-driven edge setup", "Local grant confidentiality", "Explicit local consent", "Local launch-plan compilation",
    "Filesystem grant containment", "Versioned setup reconciliation", "Installation-aware setup sequencing",
    "Installation source setup confidentiality", "Independent installation and workload consent",
    "Policy-filtered edge readiness discovery", "Independent consent for multi-edge execution",
  ]),
  "edge-managed-installation": Object.freeze([
    "Versioned installation recipes", "Managed and extensible installation providers", "Custom installation sources",
    "Exact local approval for custom execution", "Bounded custom installer execution", "Installation verification and activation",
    "Per-deployment lifecycle reporting", "Idempotent retry, update, and removal", "Installation confidentiality and audit",
  ]),
  "edge-device-operations": Object.freeze([
    "One-command edge join", "Persistent edge agent service", "Durable descriptive device inventory",
    "Dynamic presence, load, and readiness", "Policy-filtered device management commands",
    "Production edge control-plane adapters",
  ]),
  "execution-target-placement": Object.freeze([
    "Named execution targets", "Scoped MCP target bindings", "Deterministic placement precedence",
    "Ambiguous placement rejection", "Placement does not grant capability access",
    "Contextual and explainable edge device resolution", "Session-pinned edge routing", "Durable session binding contract",
    "Stable virtual edge routing", "Agent selection preserves session pinning", "Multi-edge child placement bindings",
  ]),
  "agent-native-edge-orchestration": Object.freeze([
    "Edge Control MCP surface", "Policy-filtered edge inventory discovery", "Agent-requested session selection",
    "Declarative device selection", "Explicit single-edge tool invocation", "Parallel multi-edge tool invocation",
    "Isolated child execution contexts", "Safe orchestration result contract", "Orchestration safety and audit",
  ]),
});

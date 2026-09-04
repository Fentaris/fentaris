const evidence = (title, phase, scenario, suites, expectation) => Object.freeze({
  title,
  scenario,
  expectation,
  evidenceIds: Object.freeze([
    ...[suites].flat().map((suite) => `${phase}-${suite}`),
    `${phase}-consumer-install`,
    `${phase}-practical`,
  ]),
});

const control = (title, expectation) => evidence(title, "01-control-plane-minimal", "control-plane", "control-plane-contracts", expectation);
const enrollment = (title, suite, expectation) => evidence(title, "02-single-edge-enrollment", "enrollment-cli", suite, expectation);
const workload = (title, expectation) => evidence(title, "03-basic-workload", "mcp-forwarding", "workload-runtime", expectation);
const setup = (title, expectation) => evidence(title, "04-local-setup", "local-setup", "setup-runtime", expectation);
const installation = (title, suites, expectation) => evidence(title, "05-managed-installation", "managed-installation", suites, expectation);
const resilience = (title, suites, expectation, scenario = "resilience") => evidence(title, "06-resilience-and-launchd", scenario, suites, expectation);
const routing = (title, expectation) => evidence(title, "07-multi-edge-routing", "multi-edge-routing", "routing-contracts", expectation);
const orchestration = (title, expectation) => evidence(title, "08-agent-orchestration", "agent-orchestration", "orchestration-contracts", expectation);
const security = (title, suites, expectation) => evidence(title, "09-security-and-final-soak", "security-soak", suites, expectation);

export const EDGE_REQUIREMENTS = Object.freeze({
  "integrated-edge-control-plane": Object.freeze([
    control("Integrated control-plane exposure", "The installed core resolves canonical loopback join and gateway endpoints."),
    enrollment("Explicit device-code authorization", "enrollment-runtime", "Loopback authorization, approval, polling, and token exchange pass."),
    enrollment("Device-bound enrollment and gateway authentication", "enrollment-runtime", "Enrollment proof and authenticated gateway connection pass."),
    control("Automatic application-owned desired state", "Integrated application configuration produces application-owned desired state."),
    control("Reconciliation ordering and dispatch safety", "Integrated reconciliation serializes versions and gates unsafe dispatch."),
    control("Protected single-process mode and managed adapters", "Local authority protection and managed-adapter validation pass."),
    control("Confidential and bounded control-plane responses", "Control-plane validation and redaction keep responses bounded and confidential."),
  ]),
  "edge-agent-runtime": Object.freeze([
    enrollment("Edge package and operator CLI", "operator-cli", "The installed Edge operator status command returns a stable JSON response."),
    enrollment("Device-bound enrollment identity", "enrollment-runtime", "Enrollment persists a device-bound key and rejects copied identity."),
    enrollment("Authenticated outbound edge channel", "enrollment-runtime", "The loopback Edge authenticates its outbound gateway channel."),
    workload("Versioned desired-state reconciliation", "The workload runtime serializes and applies desired-state versions."),
    workload("Session-isolated MCP process lifecycle", "Distinct sessions receive isolated workload lifecycle state."),
    workload("Governed local process execution", "Executable policy, capacity, timeout, and shutdown controls pass."),
    workload("Complete MCP operation forwarding", "An installed package starts a real stdio MCP process and calls its echo tool."),
    resilience("Edge disconnect and reconnect behavior", ["lifecycle", "resilience-contracts"], "Reconnect generations and bounded retry behavior pass."),
    resilience("Capability manifest reporting and caching", "resilience-contracts", "Capability publication, caching, and offline invalidation pass."),
    enrollment("Local revocation overrides cloud state", "enrollment-runtime", "Local revoke clears credentials and overrides replayed cloud state."),
    security("Edge observability and secret redaction", ["security-runtime", "protocol-contracts"], "Installed redaction removes sentinel values and telemetry tests pass."),
    resilience("Edge gateway adapter contracts", "resilience-contracts", "Gateway adapters preserve authenticated routing and connection generations."),
    enrollment("Integrated application control-plane interoperability", "enrollment-runtime", "A real Edge completes the loopback integrated-control-plane flow."),
    enrollment("Server-confirmed revocation", "enrollment-runtime", "Revocation confirmation and failure retention behavior pass."),
    installation("Installation-aware desired-state reconciliation", ["installation-runtime", "installation-contracts"], "Installable assignments reconcile only after verified activation."),
    installation("Durable deployment lifecycle attempts", "installation-runtime", "Attempts survive retry, interruption, and restart transitions."),
    installation("Installation lifecycle status and controls", "installation-runtime", "Status, review, approval, retry, revoke, and cleanup controls pass."),
    security("Installation telemetry and health", ["security-runtime", "protocol-contracts"], "Installation health and telemetry redact protected values."),
    routing("Attributed device metadata and presence reporting", "Inventory keeps user and observed metadata attributed and presence freshness bounded."),
  ]),
  "edge-runtime-setup": Object.freeze([
    setup("Typed runtime references", "The installed core compiles typed folder and secret runtime references."),
    setup("MCP setup schema", "Setup fields are validated against the compiled launch recipe."),
    setup("Supported setup field types", "Folder, file, secret, string, boolean, number, and select validation pass."),
    setup("Cloud target unresolved-input validation", "Cloud placement rejects unresolved Edge-only runtime inputs."),
    setup("Cloud-driven edge setup", "Assignments delivered before and after login reconcile into local setup."),
    setup("Local grant confidentiality", "Opaque local grants and secrets never enter the compiled cloud recipe."),
    setup("Explicit local consent", "Approval, denial, and revocation gate workload launch."),
    setup("Local launch-plan compilation", "A versioned installed-package launch plan resolves only declared fields."),
    setup("Filesystem grant containment", "Traversal, symlink escape, and access widening are rejected."),
    setup("Versioned setup reconciliation", "Unchanged grants are reused and changed fields are invalidated by version."),
    installation("Installation-aware setup sequencing", "installation-runtime", "Managed installation reaches readiness before setup and launch."),
    installation("Installation source setup confidentiality", "installation-runtime", "Private source credentials and local paths remain protected."),
    installation("Independent installation and workload consent", "installation-runtime", "Installation approval does not grant workload filesystem consent."),
    routing("Policy-filtered edge readiness discovery", "Inventory exposes only policy-visible ready deployments."),
    orchestration("Independent consent for multi-edge execution", "Fan-out revalidates consent independently for each selected device."),
  ]),
  "edge-managed-installation": Object.freeze([
    installation("Versioned installation recipes", "installation-contracts", "The installed core compiles an immutable recipe with a stable digest."),
    installation("Managed and extensible installation providers", ["installation-runtime", "installation-contracts"], "All provider kinds expose conforming deterministic adapters."),
    installation("Custom installation sources", "installation-runtime", "Pinned sources are staged with integrity and containment checks."),
    installation("Exact local approval for custom execution", "installation-runtime", "Approval is bound to the complete effective plan digest."),
    installation("Bounded custom installer execution", "installation-runtime", "Isolation, elevation, timeout, output, disk, and process limits fail closed."),
    installation("Installation verification and activation", "installation-runtime", "Activation occurs only after verification succeeds."),
    installation("Per-deployment lifecycle reporting", ["installation-runtime", "installation-contracts"], "Mixed deployment lifecycle states remain independently observable."),
    installation("Idempotent retry, update, and removal", "installation-runtime", "Replay, retry, update, rollback, removal, and cleanup remain idempotent."),
    installation("Installation confidentiality and audit", "installation-runtime", "Reviews and retained installer output redact secrets and private paths."),
  ]),
  "edge-device-operations": Object.freeze([
    enrollment("One-command edge join", "operator-cli", "The installed operator CLI exposes the canonical join and status contract."),
    resilience("Persistent edge agent service", "lifecycle", "Lifecycle adapters and the installed local-control process start, respond, and clean up."),
    routing("Durable descriptive device inventory", "Inventory preserves descriptions, tags, pools, aliases, and attribution."),
    routing("Dynamic presence, load, and readiness", "Inventory expires stale heartbeats and revalidates load and readiness."),
    routing("Policy-filtered device management commands", "Management results remain policy-filtered and non-enumerating."),
    resilience("Production edge control-plane adapters", "resilience-contracts", "Distributed adapter conformance and production diagnostics pass."),
  ]),
  "execution-target-placement": Object.freeze([
    routing("Named execution targets", "The installed core resolves distinct named-device and pool targets."),
    routing("Scoped MCP target bindings", "Global, group, and user bindings remain independently scoped."),
    routing("Deterministic placement precedence", "User placement wins over group and global placement deterministically."),
    routing("Ambiguous placement rejection", "Conflicting equally specific groups fail instead of choosing by declaration order."),
    routing("Placement does not grant capability access", "Placement resolution cannot enumerate or broaden hidden capabilities."),
    routing("Contextual and explainable edge device resolution", "Device selection returns bounded explanations without private data."),
    routing("Session-pinned edge routing", "The first eligible device is pinned and reused for the session."),
    routing("Durable session binding contract", "Session binding adapters preserve keys, expiry, and cleanup."),
    routing("Stable virtual edge routing", "Reconnect generations preserve the virtual route without takeover."),
    routing("Agent selection preserves session pinning", "Pre-pin selection is validated and cannot replace an active pin."),
    routing("Multi-edge child placement bindings", "Fan-out child bindings stay isolated and are removed with their parent."),
  ]),
  "agent-native-edge-orchestration": Object.freeze([
    orchestration("Edge Control MCP surface", "The installed core publishes exactly list, get, select, call, and call_many."),
    orchestration("Policy-filtered edge inventory discovery", "List and get hide inaccessible devices without enumeration."),
    orchestration("Agent-requested session selection", "Agent selection is accepted only before the immutable session pin."),
    orchestration("Declarative device selection", "Hard requirements, preferences, and deterministic ties are enforced."),
    orchestration("Explicit single-edge tool invocation", "Single-device calls re-enter the governed tool pipeline."),
    orchestration("Parallel multi-edge tool invocation", "Bounded collect and fail-fast fan-out policies pass."),
    orchestration("Isolated child execution contexts", "Two installed-package child bindings are distinct and clean up together."),
    orchestration("Safe orchestration result contract", "Mixed and malformed child results remain bounded and attributed."),
    orchestration("Orchestration safety and audit", "Consent, aggregate approval, deadlines, disconnects, and telemetry pass."),
  ]),
});

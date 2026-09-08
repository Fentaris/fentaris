import { EDGE_REQUIREMENTS } from "./requirements.mjs";

export const SENTINELS = Object.freeze([
  "edge-verification-auth-DO-NOT-LOG",
  "edge-verification-token-DO-NOT-LOG",
  "edge-verification-private-path-DO-NOT-LOG",
]);

export const PHASES = Object.freeze([
  phase("00-package-smoke", "Candidate packages", ["package-artifacts"], []),
  phase("01-control-plane-minimal", "Integrated control plane", ["control-plane"], [
    core("control-plane-contracts", "integratedConfig.test.ts", "integratedExposure.test.ts", "integratedLocalStore.test.ts", "integratedReconciliation.test.ts"),
    command("example-build", "pnpm", ["--filter", "fentaris-example-edge-control", "build"]),
  ]),
  phase("02-single-edge-enrollment", "Single Edge enrollment", ["enrollment-cli"], [
    edge("enrollment-runtime", "edge.test.ts", "integratedControlPlane.e2e.test.ts"),
    command("operator-cli", "pnpm", ["--filter", "@fentaris/cli", "exec", "vitest", "run", "test/edgeCommand.test.ts"]),
  ]),
  phase("03-basic-workload", "Basic MCP workload", ["mcp-forwarding"], [
    edge("workload-runtime", "stdioWorkload.test.ts", "supervisor.test.ts", "runtime.test.ts", "e2e.test.ts"),
  ]),
  phase("04-local-setup", "Local setup and consent", ["local-setup"], [
    edge("setup-runtime", "setup.test.ts", "installationRuntime.test.ts"),
  ]),
  phase("05-managed-installation", "Managed installation", ["managed-installation"], [
    edge("installation-runtime", "installation.test.ts", "installationRuntime.test.ts"),
    core("installation-contracts", "installation.test.ts", "installationProtocol.test.ts"),
  ]),
  phase("06-resilience-and-launchd", "Resilience and macOS launchd", ["resilience", "native-launchd"], [
    edge("lifecycle", "lifecycle.test.ts"),
    core("resilience-contracts", "capabilityCache.test.ts", "gateway.test.ts", "distributed.test.ts"),
  ]),
  phase("07-multi-edge-routing", "Multi-Edge routing", ["multi-edge-routing"], [
    core("routing-contracts", "placement.test.ts", "inventory.test.ts", "inventoryService.test.ts", "sessionBinding.test.ts", "sessionSelection.test.ts"),
    edge("routing-runtime", "e2e.test.ts"),
  ]),
  phase("08-agent-orchestration", "Agent-native orchestration", ["agent-orchestration"], [
    core("orchestration-contracts", "controlProvider.test.ts", "controlInvocation.test.ts", "fanout.test.ts"),
  ]),
  phase("09-security-and-final-soak", "Security and final soak", ["security-soak"], [
    edge("security-runtime", "security.test.ts"),
    core("protocol-contracts", "contracts.test.ts", "observability.test.ts", "protocolV2.test.ts", "transport.test.ts"),
    command("repository-verify", "pnpm", ["verify"]),
    command("release-verify", "pnpm", ["verify:release"]),
  ]),
]);

export const REQUIREMENT_SOURCES = Object.freeze(Object.entries(EDGE_REQUIREMENTS).map(([name, requirements]) => source(name, requirements)));

function phase(id, title, scenarios, commands) {
  return Object.freeze({ id, title, scenarios: Object.freeze(scenarios), commands: Object.freeze(commands) });
}

function source(name, requirements) {
  return Object.freeze({
    name,
    source: `openspec/specs/${name}/spec.md`,
    requirements,
  });
}

function command(id, executable, args) {
  return Object.freeze({ id, command: executable, args: Object.freeze(args) });
}

function edge(id, ...files) {
  return command(id, "pnpm", ["--filter", "@fentaris/edge", "exec", "vitest", "run", ...files.map((file) => `test/${file}`)]);
}

function core(id, ...files) {
  return command(id, "pnpm", ["--filter", "@fentaris/core", "exec", "vitest", "run", ...files.map((file) => `test/edge/${file}`)]);
}

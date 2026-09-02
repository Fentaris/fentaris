import { EDGE_REQUIREMENTS } from "./requirements.mjs";

export const SENTINELS = Object.freeze([
  "edge-verification-auth-DO-NOT-LOG",
  "edge-verification-token-DO-NOT-LOG",
  "edge-verification-private-path-DO-NOT-LOG",
]);

export const PHASES = Object.freeze([
  phase("00-package-smoke", "Candidate packages", ["package-artifacts"], []),
  phase("01-control-plane-minimal", "Integrated control plane", ["control-plane"], [
    core("integratedConfig.test.ts", "integratedExposure.test.ts", "integratedLocalStore.test.ts", "integratedReconciliation.test.ts"),
    ["pnpm", ["--filter", "fentaris-example-edge-control", "build"]],
  ]),
  phase("02-single-edge-enrollment", "Single Edge enrollment", ["enrollment-cli"], [
    edge("edge.test.ts", "integratedControlPlane.e2e.test.ts"),
    ["pnpm", ["--filter", "@fentaris/cli", "exec", "vitest", "run", "test/edgeCommand.test.ts"]],
  ]),
  phase("03-basic-workload", "Basic MCP workload", ["mcp-forwarding"], [
    edge("stdioWorkload.test.ts", "supervisor.test.ts", "runtime.test.ts", "e2e.test.ts"),
  ]),
  phase("04-local-setup", "Local setup and consent", ["local-setup"], [
    edge("setup.test.ts", "installationRuntime.test.ts"),
  ]),
  phase("05-managed-installation", "Managed installation", ["managed-installation"], [
    edge("installation.test.ts", "installationRuntime.test.ts"),
    core("installation.test.ts", "installationProtocol.test.ts"),
  ]),
  phase("06-resilience-and-launchd", "Resilience and macOS launchd", ["resilience", "native-launchd"], [
    edge("lifecycle.test.ts"),
    core("capabilityCache.test.ts", "gateway.test.ts", "distributed.test.ts"),
  ]),
  phase("07-multi-edge-routing", "Multi-Edge routing", ["multi-edge-routing"], [
    core("placement.test.ts", "inventory.test.ts", "inventoryService.test.ts", "sessionBinding.test.ts", "sessionSelection.test.ts"),
    edge("e2e.test.ts"),
  ]),
  phase("08-agent-orchestration", "Agent-native orchestration", ["agent-orchestration"], [
    core("controlProvider.test.ts", "controlInvocation.test.ts", "fanout.test.ts"),
  ]),
  phase("09-security-and-final-soak", "Security and final soak", ["security-soak"], [
    edge("security.test.ts"),
    core("contracts.test.ts", "observability.test.ts", "protocolV2.test.ts", "transport.test.ts"),
    ["pnpm", ["verify"]],
    ["pnpm", ["verify:release"]],
  ]),
]);

export const REQUIREMENT_SOURCES = Object.freeze([
  source("integrated-edge-control-plane", ["control-plane", "enrollment-cli"]),
  source("edge-agent-runtime", ["enrollment-cli", "mcp-forwarding", "resilience", "managed-installation"]),
  source("edge-runtime-setup", ["local-setup"]),
  source("edge-managed-installation", ["managed-installation"]),
  source("edge-device-operations", ["enrollment-cli", "resilience", "native-launchd"]),
  source("execution-target-placement", ["multi-edge-routing"]),
  source("agent-native-edge-orchestration", ["agent-orchestration"]),
]);

function phase(id, title, scenarios, commands) {
  return Object.freeze({ id, title, scenarios: Object.freeze(scenarios), commands: Object.freeze(commands) });
}

function source(name, scenarios) {
  return Object.freeze({
    name,
    source: `openspec/specs/${name}/spec.md`,
    requirements: EDGE_REQUIREMENTS[name],
    scenarios: Object.freeze(scenarios),
  });
}

function edge(...files) {
  return ["pnpm", ["--filter", "@fentaris/edge", "exec", "vitest", "run", ...files.map((file) => `test/${file}`)]];
}

function core(...files) {
  return ["pnpm", ["--filter", "@fentaris/core", "exec", "vitest", "run", ...files.map((file) => `test/edge/${file}`)]];
}

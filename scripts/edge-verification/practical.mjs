#!/usr/bin/env node
import assert from "node:assert/strict";
import path from "node:path";
import {
  DEFAULT_EDGE_ORCHESTRATION_LIMITS,
  EDGE_CONTROL_TOOL_NAMES,
  EdgeChildBindingManager,
  InMemoryEdgeChildBindingStore,
  PlacementResolver,
  buildEdgeControlPlaneUrls,
  compileInstallationRecipe,
  compileLaunchRecipe,
  createSetupSchema,
  edge,
  normalizeEdgeControlPlaneConfig,
  runtime,
} from "@fentaris/core";
import {
  EdgeLocalControlServer,
  StdioEdgeWorkloadFactory,
  buildInstallationReview,
  callEdgeLocalControl,
  createEdgeLocalControlCredential,
  edgeLocalControlAddress,
  redactEdgeValue,
  runEdgeCli,
} from "@fentaris/edge";

const phase = process.argv[2];
const scenarios = {
  "01-control-plane-minimal": controlPlane,
  "02-single-edge-enrollment": operatorCli,
  "03-basic-workload": stdioWorkload,
  "04-local-setup": localSetup,
  "05-managed-installation": managedInstallation,
  "06-resilience-and-launchd": localControl,
  "07-multi-edge-routing": multiEdgeRouting,
  "08-agent-orchestration": agentOrchestration,
  "09-security-and-final-soak": securitySoak,
};
const scenario = scenarios[phase];
if (!scenario) throw new Error(`No installed-package practical scenario for ${phase}`);
const observable = await scenario();
console.log(JSON.stringify({ phase, status: "passed", observable }));

async function controlPlane() {
  const config = normalizeEdgeControlPlaneConfig({ enabled: true, mode: "local", publicOrigin: "http://127.0.0.1:43100" });
  assert.equal(config.enabled, true);
  const urls = buildEdgeControlPlaneUrls(config.publicOrigin, config.basePath);
  assert.equal(urls.gatewayUrl, "ws://127.0.0.1:43100/_fentaris/edge/ws");
  return { joinBaseUrl: urls.joinBaseUrl, gatewayUrl: urls.gatewayUrl };
}

async function operatorCli() {
  const output = [];
  const errors = [];
  const code = await runEdgeCli(["status"], {
    status: async () => ({ connected: true, edgeNodeId: "installed-edge", tenantId: "verification" }),
  }, { out: (value) => output.push(value), error: (value) => errors.push(value) });
  assert.equal(code, 0);
  assert.equal(errors.length, 0);
  assert.equal(JSON.parse(output[0]).edgeNodeId, "installed-edge");
  return { command: "status", code, response: JSON.parse(output[0]) };
}

async function stdioWorkload() {
  const factory = new StdioEdgeWorkloadFactory();
  const workload = await factory.start({
    deploymentId: "installed-fixture",
    recipeDigest: "sha256:installed-fixture",
    command: process.execPath,
    args: [path.join(process.cwd(), "fixture-mcp.mjs")],
    env: {},
  }, new AbortController().signal);
  try {
    const manifest = await workload.client.capabilityManifest();
    assert.equal(manifest.tools[0].name, "echo");
    const response = await workload.client.request("tools/call", { name: "echo", arguments: { text: "installed-edge-ok" } }, new AbortController().signal);
    assert.equal(response.content[0].text, "installed-edge-ok");
    return { tool: manifest.tools[0].name, response: response.content[0].text };
  } finally {
    await workload.stopGracefully();
  }
}

async function localSetup() {
  const schema = createSetupSchema({
    workspace: edge.folder({ access: "read" }),
    token: edge.secret({ label: "API token" }),
  }, 2);
  const recipe = compileLaunchRecipe({
    command: process.execPath,
    args: ["fixture-mcp.mjs", runtime.input("workspace")],
    env: { FIXTURE_TOKEN: runtime.secret("token") },
  }, schema);
  assert.deepEqual(recipe.setupFieldRefs, ["token", "workspace"]);
  assert.equal(JSON.stringify(recipe).includes(process.env.FENTARIS_EDGE_TEST_TOKEN ?? "never-present"), false);
  return { schemaVersion: schema.version, setupFieldRefs: recipe.setupFieldRefs };
}

async function managedInstallation() {
  const recipe = compileInstallationRecipe({
    provider: {
      kind: "manual",
      requirement: "Node.js 24",
      detect: { kind: "command", target: "bin/node", args: ["--version"] },
      nextAction: "Install Node.js 24",
    },
    permissions: {
      network: "none",
      elevation: false,
      limits: { timeoutMs: 30_000, maxOutputBytes: 65_536, maxDiskBytes: 1_048_576, maxProcesses: 1 },
    },
    verification: [{ kind: "command", target: "bin/node", args: ["--version"] }],
    outputs: [{ name: "node", kind: "executable", path: "bin/node" }],
    retention: { previousVersions: 1 },
    cleanup: { kind: "managed-directory" },
  });
  const review = buildInstallationReview(recipe, { allow: "manual" });
  assert.equal(review.provider, "manual");
  assert.equal(review.recipeDigest, recipe.digest);
  return { provider: review.provider, recipeDigest: review.recipeDigest, approvalDigest: review.approvalDigest };
}

async function localControl() {
  const endpoint = { address: edgeLocalControlAddress(process.cwd()), credential: createEdgeLocalControlCredential() };
  const server = new EdgeLocalControlServer({
    endpoint,
    agent: {
      status: async () => ({ connected: true, edgeNodeId: "installed-control" }),
      reconnectNow: async () => undefined,
      stop: async () => undefined,
    },
  });
  await server.start();
  try {
    const response = await callEdgeLocalControl(endpoint, "status");
    assert.equal(response.ok, true);
    assert.equal(response.data.edgeNodeId, "installed-control");
    return { addressLength: endpoint.address.length, response: response.data };
  } finally {
    await server.stop();
  }
}

async function multiEdgeRouting() {
  const targets = new Map([
    ["personal", edge({ device: edge.namedDevice("laptop") })],
    ["shared", edge({ device: edge.pool("build", "least-loaded") })],
  ]);
  const resolver = new PlacementResolver({
    targets,
    bindings: [
      { serverName: "workspace", scope: "global", targetName: "shared" },
      { serverName: "workspace", scope: "user", userId: "owner", targetName: "personal" },
    ],
  });
  const owner = resolver.resolve({ serverName: "workspace", subjectId: "owner", groupIds: [] });
  const guest = resolver.resolve({ serverName: "workspace", subjectId: "guest", groupIds: [] });
  assert.deepEqual([owner.targetName, guest.targetName], ["personal", "shared"]);
  return { owner, guest };
}

async function agentOrchestration() {
  assert.deepEqual([...EDGE_CONTROL_TOOL_NAMES], ["list", "get", "select", "call", "call_many"]);
  assert.equal(DEFAULT_EDGE_ORCHESTRATION_LIMITS.maxConcurrency, 4);
  const manager = new EdgeChildBindingManager({
    store: new InMemoryEdgeChildBindingStore(),
    now: () => 1_000,
    createId: (() => { let id = 0; return () => `child-${id += 1}`; })(),
  });
  const first = await manager.allocate({ parentSessionId: "session", parentRequestId: "request", tenantId: "tenant", subjectId: "owner", targetName: "personal", edgeNodeId: "edge-a", connectionGeneration: 1, ttlMs: 1_000 });
  const second = await manager.allocate({ parentSessionId: "session", parentRequestId: "request", tenantId: "tenant", subjectId: "owner", targetName: "personal", edgeNodeId: "edge-b", connectionGeneration: 1, ttlMs: 1_000 });
  assert.notEqual(first.binding.childBindingId, second.binding.childBindingId);
  const removed = await manager.endParent("session", "request");
  assert.equal(removed.length, 2);
  return { tools: EDGE_CONTROL_TOOL_NAMES, isolatedChildren: 2, cleanedChildren: removed.length };
}

async function securitySoak() {
  const protectedValue = process.env.FENTARIS_EDGE_TEST_TOKEN;
  assert.ok(protectedValue);
  const serialized = JSON.stringify(redactEdgeValue({ token: protectedValue, nested: { authorization: protectedValue } }));
  assert.equal(serialized.includes(protectedValue), false);
  assert.match(serialized, /\[REDACTED\]/);
  return { sentinelRedacted: true, retainedSecret: false };
}

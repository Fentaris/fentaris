import { describe, expect, it, vi } from "vitest";
import {
  EDGE_MCP_ENVELOPE_VERSION,
  compileLaunchRecipe,
  createSetupSchema,
  type EdgeMcpOperation,
  type EdgeMcpRequestEnvelope,
} from "@fentaris/core";
import {
  EdgeWorkloadSupervisor,
  type CompiledLocalLaunchPlan,
  type DesiredSetupRequirement,
  type EdgeWorkload,
  type EdgeWorkloadFactory,
  type LocalMcpClient,
  type LocalSetupManager,
} from "../src/index.js";

function requirement(deploymentId = "fixture"): DesiredSetupRequirement {
  const schema = createSetupSchema({});
  return {
    deploymentId,
    desiredStateVersion: 1,
    schema,
    recipe: compileLaunchRecipe({ command: deploymentId }, schema),
  };
}

class SetupStub {
  status: "ready" | "pending" = "ready";
  readonly ingest = vi.fn(async (desired: DesiredSetupRequirement) => ({
    deploymentId: desired.deploymentId,
    desiredStateVersion: desired.desiredStateVersion,
    recipeDigest: desired.recipe.digest,
    setupSchemaVersion: desired.schema.version,
    status: this.status,
    grantRefs: {},
    fieldDigests: {},
    missingFields: this.status === "ready" ? [] : ["workspace"],
  }));
  readonly compileLaunchPlan = vi.fn(async (desired: DesiredSetupRequirement): Promise<CompiledLocalLaunchPlan> => ({
    deploymentId: desired.deploymentId,
    recipeDigest: desired.recipe.digest,
    command: desired.recipe.command,
    args: [],
    env: {},
  }));
}

class ClientStub implements LocalMcpClient {
  readonly calls: EdgeMcpOperation[] = [];
  result: unknown = { content: [{ type: "text", text: "ok" }] };
  waitForAbort = false;
  async request(operation: EdgeMcpOperation, _params: unknown, signal: AbortSignal): Promise<unknown> {
    this.calls.push(operation);
    if (!this.waitForAbort) return this.result;
    return new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  }
}

function factory(clientFactory: () => ClientStub = () => new ClientStub()) {
  const workloads: Array<EdgeWorkload & { client: ClientStub; graceful: ReturnType<typeof vi.fn>; force: ReturnType<typeof vi.fn> }> = [];
  const edgeFactory: EdgeWorkloadFactory = {
    start: vi.fn(async () => {
      const workload = {
        client: clientFactory(),
        graceful: vi.fn(async () => undefined),
        force: vi.fn(async () => undefined),
        stopGracefully() { return this.graceful(); },
        forceKill() { return this.force(); },
      };
      workloads.push(workload);
      return workload;
    }),
  };
  return { edgeFactory, workloads };
}

function request(overrides: Partial<EdgeMcpRequestEnvelope> & {
  deploymentId?: string;
  sessionId?: string;
  requestId?: string;
} = {}): EdgeMcpRequestEnvelope {
  return {
    version: EDGE_MCP_ENVELOPE_VERSION,
    kind: "mcp.request",
    requestId: overrides.requestId ?? "request-1",
    operation: overrides.operation ?? "tools/call",
    route: {
      edgeNodeId: "node-1",
      connectionGeneration: 1,
      deploymentId: overrides.deploymentId ?? "fixture",
      downstreamSessionId: overrides.sessionId ?? "session-1",
      targetName: "personal",
    },
    deadline: overrides.deadline ?? Date.now() + 10_000,
    params: overrides.params ?? { name: "status" },
  };
}

function supervisor(options: {
  setup?: SetupStub;
  edgeFactory?: EdgeWorkloadFactory;
  now?: () => number;
  maxConcurrentWorkloads?: number;
  startupTimeoutMs?: number;
  operationTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  idleLeaseMs?: number;
  maxOutputBytes?: number;
  allow?: boolean;
} = {}) {
  const setup = options.setup ?? new SetupStub();
  const created = factory();
  const instance = new EdgeWorkloadSupervisor({
    setup: setup as unknown as LocalSetupManager,
    factory: options.edgeFactory ?? created.edgeFactory,
    now: options.now,
    maxConcurrentWorkloads: options.maxConcurrentWorkloads,
    startupTimeoutMs: options.startupTimeoutMs,
    operationTimeoutMs: options.operationTimeoutMs,
    shutdownTimeoutMs: options.shutdownTimeoutMs,
    idleLeaseMs: options.idleLeaseMs,
    maxOutputBytes: options.maxOutputBytes,
    executablePolicy: options.allow === undefined ? undefined : { allow: async () => options.allow! },
  });
  return { instance, setup, created };
}

describe("EdgeWorkloadSupervisor", () => {
  it("reconciles desired deployments and creates one idempotent workload per deployment/session", async () => {
    const fixture = supervisor();
    await expect(fixture.instance.reconcile([{ requirement: requirement() }])).resolves.toEqual([
      { deploymentId: "fixture", status: "ready" },
    ]);

    const [first, duplicate] = await Promise.all([
      fixture.instance.handleRequest(request({ requestId: "one" })),
      fixture.instance.handleRequest(request({ requestId: "two" })),
    ]);
    expect(first.kind).toBe("mcp.result");
    expect(duplicate.kind).toBe("mcp.result");
    expect(fixture.created.edgeFactory.start).toHaveBeenCalledOnce();

    await fixture.instance.handleRequest(request({ requestId: "three", sessionId: "session-2" }));
    expect(fixture.created.edgeFactory.start).toHaveBeenCalledTimes(2);
    expect(fixture.instance.activeWorkloadCount()).toBe(2);

    await fixture.instance.endSession("session-1");
    expect(fixture.instance.activeWorkloadCount()).toBe(1);
    expect(fixture.created.workloads[0].graceful).toHaveBeenCalledOnce();
    await expect(fixture.instance.reconcile([])).resolves.toContainEqual({
      deploymentId: "fixture",
      status: "removed",
    });
    expect(fixture.instance.activeWorkloadCount()).toBe(0);
  });

  it("forwards every MCP operation and enforces executable policy, capacity, output, and setup readiness", async () => {
    const fixture = supervisor();
    await fixture.instance.reconcile([{ requirement: requirement() }]);
    const operations: EdgeMcpOperation[] = [
      "tools/list",
      "tools/call",
      "resources/list",
      "resources/read",
      "resources/templates/list",
      "prompts/list",
      "prompts/get",
      "completion/complete",
      "ping",
    ];
    for (const operation of operations) {
      await expect(fixture.instance.handleRequest(request({
        operation,
        requestId: operation,
      }))).resolves.toMatchObject({ kind: "mcp.result", operation });
    }
    expect(fixture.created.workloads[0].client.calls).toEqual(operations);

    const denied = supervisor({ allow: false });
    await denied.instance.reconcile([{ requirement: requirement() }]);
    await expect(denied.instance.handleRequest(request())).resolves.toMatchObject({
      kind: "mcp.error",
      error: { code: "EDGE_WORKLOAD" },
    });

    const blockedSetup = new SetupStub();
    blockedSetup.status = "pending";
    const blocked = supervisor({ setup: blockedSetup });
    await expect(blocked.instance.reconcile([{ requirement: requirement() }])).resolves.toMatchObject([
      { status: "blocked", reason: "setup-pending" },
    ]);
    await expect(blocked.instance.handleRequest(request())).resolves.toMatchObject({
      error: { code: "EDGE_SETUP_REQUIRED" },
    });

    const capacity = supervisor({ maxConcurrentWorkloads: 1 });
    await capacity.instance.reconcile([{ requirement: requirement() }]);
    await capacity.instance.handleRequest(request({ sessionId: "one" }));
    await expect(capacity.instance.handleRequest(request({ sessionId: "two" }))).resolves.toMatchObject({
      error: { code: "EDGE_CAPACITY" },
    });

    const outputFactory = factory();
    const output = supervisor({ edgeFactory: outputFactory.edgeFactory, maxOutputBytes: 4 });
    await output.instance.reconcile([{ requirement: requirement() }]);
    await expect(output.instance.handleRequest(request())).resolves.toMatchObject({
      error: { code: "EDGE_CAPACITY" },
    });
  });

  it("propagates cancellation/timeouts and forces termination after graceful shutdown deadline", async () => {
    const cancelFactory = factory(() => {
      const client = new ClientStub();
      client.waitForAbort = true;
      return client;
    });
    const fixture = supervisor({
      edgeFactory: cancelFactory.edgeFactory,
      operationTimeoutMs: 1_000,
      shutdownTimeoutMs: 5,
    });
    await fixture.instance.reconcile([{ requirement: requirement() }]);
    const pending = fixture.instance.handleRequest(request({ requestId: "cancel-me" }));
    await vi.waitFor(() => expect(cancelFactory.workloads).toHaveLength(1));
    expect(fixture.instance.handleCancel({
      version: EDGE_MCP_ENVELOPE_VERSION,
      kind: "mcp.cancel",
      requestId: "cancel-me",
      route: request().route,
      reason: "aborted",
    })).toBe(true);
    await expect(pending).resolves.toMatchObject({ error: { code: "EDGE_WORKLOAD" } });

    cancelFactory.workloads[0].graceful.mockImplementation(() => new Promise(() => undefined));
    await fixture.instance.endSession("session-1");
    expect(cancelFactory.workloads[0].force).toHaveBeenCalledOnce();

    const timeoutFactory = factory(() => {
      const client = new ClientStub();
      client.waitForAbort = true;
      return client;
    });
    const timed = supervisor({ edgeFactory: timeoutFactory.edgeFactory, operationTimeoutMs: 5 });
    await timed.instance.reconcile([{ requirement: requirement() }]);
    await expect(timed.instance.handleRequest(request())).resolves.toMatchObject({
      error: { code: "EDGE_WORKLOAD", message: expect.stringMatching(/timed out/) },
    });
  });

  it("keeps local denial sticky across desired-state replay and cleans idle workloads", async () => {
    let now = 100;
    const fixture = supervisor({ now: () => now, idleLeaseMs: 10 });
    await fixture.instance.reconcile([{ requirement: requirement() }]);
    await fixture.instance.handleRequest(request());
    await fixture.instance.denyDeployment("fixture");
    expect(fixture.instance.activeWorkloadCount()).toBe(0);
    await expect(fixture.instance.reconcile([{ requirement: requirement() }])).resolves.toMatchObject([
      { status: "blocked", reason: "local-deny" },
    ]);
    fixture.instance.renewConsent("fixture");
    await fixture.instance.reconcile([{ requirement: requirement() }]);
    await fixture.instance.handleRequest(request());
    now = 111;
    await expect(fixture.instance.sweepIdle()).resolves.toHaveLength(1);
    expect(fixture.instance.activeWorkloadCount()).toBe(0);
  });

  it("rejects startup timeout and expires requests whose cloud deadline has passed", async () => {
    const never: EdgeWorkloadFactory = { start: () => new Promise(() => undefined) };
    const fixture = supervisor({ edgeFactory: never, startupTimeoutMs: 5 });
    await fixture.instance.reconcile([{ requirement: requirement() }]);
    await expect(fixture.instance.handleRequest(request())).resolves.toMatchObject({
      error: { code: "EDGE_WORKLOAD", message: expect.stringMatching(/startup timed out/) },
    });
    await expect(fixture.instance.handleRequest(request({ deadline: Date.now() - 1 }))).resolves.toMatchObject({
      error: { code: "EDGE_WORKLOAD", message: expect.stringMatching(/already expired/) },
    });
  });
});

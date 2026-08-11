import path from "node:path";
import {
  EdgeLocalControlServer,
  EdgePersistentAgent,
  FileEdgeSingletonLock,
  ProtectedJsonStore,
  callEdgeLocalControl,
  createDefaultEdgeAgent,
  createEdgeLocalControlCredential,
  defaultEdgePaths,
  edgeLocalControlAddress,
  edgeServiceAdapter,
  nodeEdgePlatform,
  type EdgePersistentStatus,
  type EdgeServiceOperation,
} from "@fentaris/edge";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";
import {
  EdgeLocalOperatorClient,
  readEdgeLocalOperatorEndpoint,
  type EdgeLocalOperatorClientRequest,
} from "@fentaris/core";
import { discoverProject } from "../domain/project/project.js";

export interface EdgeCliNextAction {
  readonly description: string;
  readonly command: string;
}

export interface EdgeJoinVerification {
  readonly verificationUri: string;
  readonly userCode: string;
}

export type EdgeCliEnvelope<T> = {
  readonly ok: true;
  readonly data: T;
  readonly pagination: { readonly nextCursor?: string } | null;
  readonly warnings: readonly string[];
  readonly nextActions: readonly EdgeCliNextAction[];
} | {
  readonly ok: false;
  readonly error: { readonly code: string; readonly message: string; readonly details: Readonly<Record<string, unknown>> };
  readonly warnings: readonly string[];
  readonly nextActions: readonly EdgeCliNextAction[];
};

export interface EdgeOperatorBackend {
  join(input: {
    readonly controlPlaneUrl: string;
    readonly name?: string;
    readonly description?: string;
    readonly tags: readonly string[];
    readonly installService: boolean;
    readonly requireService: boolean;
    readonly onVerification?: (verification: EdgeJoinVerification) => void;
  }): Promise<EdgeCliEnvelope<unknown>>;
  run(): Promise<EdgeCliEnvelope<unknown>>;
  service(operation: EdgeServiceOperation): Promise<EdgeCliEnvelope<unknown>>;
  list(options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  get(device: string, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  status(device: string | undefined, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  update(device: string, input: { expectedVersion: number; name?: string; description?: string; tags?: readonly string[] }): Promise<EdgeCliEnvelope<unknown>>;
  disconnect(device: string): Promise<EdgeCliEnvelope<unknown>>;
  revoke(device: string): Promise<EdgeCliEnvelope<unknown>>;
  installation(action: EdgeInstallationAction, deploymentId: string | undefined, options: { readonly cleanup?: boolean }): Promise<EdgeCliEnvelope<unknown>>;
  approve(userCode: string, decision: { readonly tenantId: string; readonly subjectId: string; readonly actorId: string; readonly approvedAt: number }): Promise<EdgeCliEnvelope<unknown>>;
}

export type EdgeInstallationAction = "status" | "review" | "approve" | "deny" | "retry" | "revoke" | "cleanup";

export interface EdgeRemoteQuery {
  readonly compact?: boolean;
  readonly limit?: number;
  readonly cursor?: string;
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
  readonly as?: string;
}

export async function runEdge(
  command: CliCommand,
  runtime: Runtime,
  backend: EdgeOperatorBackend = new DefaultEdgeOperatorBackend(runtime),
): Promise<number> {
  try {
    const action = command.args[0];
    let envelope: EdgeCliEnvelope<unknown>;
    switch (action) {
      case "join": {
        if (command.options.service === true && command.options["no-service"] === true) {
          return printFailure(runtime, command.options, "EDGE_CLI_USAGE", "--service and --no-service cannot be used together.", 2);
        }
        envelope = await backend.join({
          controlPlaneUrl: requiredArg(command.args[1], "edge join requires a control-plane URL"),
          name: stringOption(command.options, "name"),
          description: stringOption(command.options, "description"),
          tags: listOption(command.options, "tag") ?? [],
          installService: command.options["no-service"] !== true,
          requireService: command.options.service === true,
          onVerification: (verification) => printJoinVerification(runtime, command.options, verification),
        });
        break;
      }
      case "run":
        envelope = await backend.run();
        break;
      case "approve": {
        const userCode = requiredArg(command.args[1], "edge approve requires a user code");
        const subjectId = stringOption(command.options, "subject");
        if (!subjectId) {
          return printFailure(runtime, command.options, "EDGE_CLI_USAGE", "edge approve requires --subject.", 2, [{
            description: "Approve for an explicit Fentaris subject",
            command: `fentaris edge approve ${shellArg(userCode)} --subject user:<name> --yes --json`,
          }]);
        }
        const tenantId = stringOption(command.options, "tenant") ?? "default";
        const actorId = stringOption(command.options, "actor") ?? runtime.env.USER ?? "local-operator";
        if (!await confirmApproval(runtime, command.options, userCode, subjectId, tenantId)) {
          return printFailure(runtime, command.options, "CONFIRMATION_REQUIRED", "Edge authorization approval was not confirmed.", 2, [{
            description: "Confirm this exact approval non-interactively",
            command: `fentaris edge approve ${shellArg(userCode)} --subject ${shellArg(subjectId)} --tenant ${shellArg(tenantId)} --yes --json`,
          }]);
        }
        envelope = await backend.approve(userCode, { tenantId, subjectId, actorId, approvedAt: Date.now() });
        break;
      }
      case "service":
        envelope = await backend.service(requiredServiceOperation(command.args[1]));
        break;
      case "list":
        envelope = await backend.list(remoteQuery(command.options));
        break;
      case "get":
        envelope = await backend.get(requiredArg(command.args[1], "edge get requires a device"), remoteQuery(command.options));
        break;
      case "status":
        envelope = await backend.status(command.args[1], remoteQuery(command.options));
        break;
      case "installation": {
        const installationAction = requiredInstallationAction(command.args[1]);
        const deploymentId = command.args[2];
        if (installationAction !== "status" && !deploymentId) {
          return printFailure(runtime, command.options, "EDGE_CLI_USAGE", `edge installation ${installationAction} requires a deployment ID.`, 2);
        }
        if (["approve", "deny", "retry", "revoke", "cleanup"].includes(installationAction)
          && !await confirmInstallationMutation(runtime, command.options, installationAction, deploymentId!)) {
          return printFailure(runtime, command.options, "CONFIRMATION_REQUIRED", `${installationAction} was not confirmed.`, 2, [{
            description: `Confirm ${installationAction} non-interactively`,
            command: `fentaris edge installation ${installationAction} ${shellArg(deploymentId!)} --yes --json`,
          }]);
        }
        envelope = await backend.installation(installationAction, deploymentId, { cleanup: command.options.cleanup === true });
        break;
      }
      case "update": {
        const expectedVersion = numberOption(command.options, "expected-version");
        if (expectedVersion === undefined) {
          return printFailure(runtime, command.options, "EDGE_CLI_USAGE", "edge update requires --expected-version.", 2, [{
            description: "Inspect the current inventory version",
            command: `fentaris edge get ${shellArg(command.args[1] ?? "<device>")} --json`,
          }]);
        }
        envelope = await backend.update(requiredArg(command.args[1], "edge update requires a device"), {
          expectedVersion,
          name: stringOption(command.options, "name"),
          description: stringOption(command.options, "description"),
          tags: listOption(command.options, "tag"),
        });
        break;
      }
      case "disconnect":
      case "revoke": {
        const device = requiredArg(command.args[1], `edge ${action} requires a device`);
        if (!await confirmMutation(runtime, command.options, action, device)) {
          return printFailure(runtime, command.options, "CONFIRMATION_REQUIRED", `${action} was not confirmed.`, 2, [{
            description: `Confirm ${action} non-interactively`,
            command: `fentaris edge ${action} ${shellArg(device)} --yes --json`,
          }]);
        }
        envelope = action === "disconnect" ? await backend.disconnect(device) : await backend.revoke(device);
        break;
      }
      default:
        return printFailure(runtime, command.options, "EDGE_CLI_USAGE", `Unknown edge command "${action ?? ""}".`, 2);
    }
    printEnvelope(runtime, envelope, command.options);
    return envelope.ok ? 0 : exitCodeFor(envelope.error.code);
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "EDGE_COMMAND_FAILED";
    return printFailure(runtime, command.options, code, error instanceof Error ? error.message : String(error), exitCodeFor(code));
  }
}

export class DefaultEdgeOperatorBackend implements EdgeOperatorBackend {
  private readonly paths = defaultEdgePaths();
  private readonly platform = nodeEdgePlatform(this.paths);

  constructor(private readonly runtime: Runtime) {}

  async join(input: Parameters<EdgeOperatorBackend["join"]>[0]): Promise<EdgeCliEnvelope<unknown>> {
    const verification: unknown[] = [];
    const agent = createDefaultEdgeAgent({
      controlPlaneUrl: input.controlPlaneUrl,
      platform: this.platform,
      onVerification: (request) => {
        const pending = { verificationUri: request.verificationUri, userCode: request.userCode };
        verification.push(pending);
        input.onVerification?.(pending);
      },
    });
    const joined = await agent.login({ name: input.name, description: input.description, tags: input.tags });
    const warnings: string[] = [];
    const nextActions: EdgeCliNextAction[] = [];
    let service: unknown = { persistent: false, adapter: "foreground" };
    if (input.installService) {
      try {
        service = await this.adapter().install(this.definition());
      } catch (error) {
        if (input.requireService) throw error;
        warnings.push("Persistent service installation was unavailable; enrollment identity was retained.");
        nextActions.push({ description: "Run Edge in the foreground", command: "fentaris edge run" });
      }
    } else {
      nextActions.push({ description: "Run Edge in the foreground", command: "fentaris edge run" });
    }
    await agent.disconnect();
    return success({
      status: joined.repeated ? "already-enrolled" : "enrolled",
      device: { name: input.name ?? joined.config.hostnameLabel ?? "edge-device" },
      service,
      verification,
    }, null, warnings, nextActions);
  }

  async run(): Promise<EdgeCliEnvelope<unknown>> {
    const enrolled = await this.platform.configStore.load();
    const controlPlaneUrl = enrolled?.controlPlaneUrl
      ?? this.runtime.env.FENTARIS_EDGE_CONTROL_PLANE_URL
      ?? "";
    if (!controlPlaneUrl) {
      throw new Error("The enrolled Edge configuration has no control-plane URL; join again or set FENTARIS_EDGE_CONTROL_PLANE_URL.");
    }
    const agent = createDefaultEdgeAgent({ controlPlaneUrl, platform: this.platform, onVerification: () => undefined });
    const persistent = new EdgePersistentAgent({
      agent,
      lock: new FileEdgeSingletonLock(path.join(this.paths.dataDir, "agent.lock")),
      statusStore: new ProtectedJsonStore<EdgePersistentStatus>(path.join(this.paths.dataDir, "status.json")),
    });
    const credential = await this.controlCredential();
    const control = new EdgeLocalControlServer({
      endpoint: { address: edgeLocalControlAddress(this.paths.dataDir), credential },
      agent: persistent,
      ...(agent.installationControl() ? { installation: agent.installationControl()! } : {}),
    });
    await persistent.start();
    try {
      await control.start();
      await persistent.wait();
    } finally {
      try {
        await control.stop();
      } finally {
        await persistent.stop();
      }
    }
    const terminal = await persistent.status();
    if (terminal.state === "terminal") {
      return failure(
        terminal.errorCode ?? "EDGE_UNAVAILABLE",
        "Edge agent stopped after a terminal connection error. Join the device again before retrying.",
      );
    }
    return success({ status: "stopped" });
  }

  async service(operation: EdgeServiceOperation): Promise<EdgeCliEnvelope<unknown>> {
    const adapter = this.adapter();
    if (operation === "install") return success(await adapter.install(this.definition()));
    if (operation === "start") return success(await adapter.start());
    if (operation === "stop") return success(await adapter.stop());
    if (operation === "restart") return success(await adapter.restart());
    return success(await adapter.uninstall());
  }

  async list(options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>> {
    const localGate = await this.localDiscoveryGate(options);
    if (localGate) return localGate;
    const local = await this.localManagement({
      command: "device-list",
      context: managementContext(options),
      options: { ...(options.limit ? { limit: options.limit } : {}), ...(options.cursor ? { cursor: options.cursor } : {}) },
    });
    if (local) return shapeLocalDiscovery(local, options);
    return this.remote("GET", "/edge/devices", undefined, options);
  }
  async get(device: string, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>> {
    const localGate = await this.localDiscoveryGate(options);
    if (localGate) return localGate;
    const local = await this.localManagement({ command: "device-get", context: managementContext(options), deviceName: device });
    if (local) return shapeLocalDiscovery(local, options);
    return this.remote("GET", `/edge/devices/${encodeURIComponent(device)}`, undefined, options);
  }
  async status(device: string | undefined, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>> {
    if (device) {
      const localGate = await this.localDiscoveryGate(options);
      if (localGate) return localGate;
      const local = await this.localManagement({ command: "device-get", context: managementContext(options), deviceName: device });
      if (local) return shapeLocalDiscovery(local, options);
      return this.remote("GET", `/edge/devices/${encodeURIComponent(device)}/status`, undefined, options);
    }
    const credential = await this.platform.credentialStore.get("local-control-credential");
    if (credential) {
      try {
        const endpoint = { address: edgeLocalControlAddress(this.paths.dataDir), credential };
        const response = await callEdgeLocalControl(endpoint, "status");
        if (!response.ok) return failure(response.error?.code ?? "EDGE_UNAVAILABLE", response.error?.message ?? "Local Edge status failed.");
        const installations = await callEdgeLocalControl(endpoint, "installation-status").catch(() => ({ ok: true, data: { readiness: [] } }));
        const status = response.data && typeof response.data === "object" ? response.data as Record<string, unknown> : { state: "unknown" };
        return success({ ...status, device: { presence: status.agent && typeof status.agent === "object" ? (status.agent as Record<string, unknown>).connected === true ? "online" : "offline" : "unknown" }, service: { state: status.state ?? "unknown" }, deployments: installations.ok ? installations.data : [] });
      } catch {
        // Fall through to safe persisted/local status.
      }
    }
    const persisted = await new ProtectedJsonStore<EdgePersistentStatus>(path.join(this.paths.dataDir, "status.json")).load();
    const revoked = persisted?.state === "terminal" && persisted.errorCode === "EDGE_UNAUTHORIZED_TARGET";
    const enrolled = revoked ? await this.platform.configStore.load() : undefined;
    return success(
      persisted ?? { state: "stopped" },
      null,
      persisted ? [] : ["No persistent Edge runtime status is available."],
      revoked
        ? [{
            description: "Join the revoked device again with a new authorization",
            command: `fentaris edge join ${shellArg(enrolled?.controlPlaneUrl ?? "<control-plane-url>")}`,
          }]
        : [{ description: "Run Edge in the foreground", command: "fentaris edge run" }],
    );
  }
  async update(device: string, input: Parameters<EdgeOperatorBackend["update"]>[1]): Promise<EdgeCliEnvelope<unknown>> {
    const local = await this.localManagement({
      command: "device-update",
      context: { tenantId: "default" },
      deviceName: device,
      update: {
        expectedInventoryVersion: input.expectedVersion,
        updatedAt: Date.now(),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
      },
    });
    if (local) return local;
    return this.remote("PATCH", `/edge/devices/${encodeURIComponent(device)}`, input);
  }
  async disconnect(device: string): Promise<EdgeCliEnvelope<unknown>> {
    const local = await this.localManagement({ command: "device-disconnect", context: { tenantId: "default" }, deviceName: device });
    if (local) return local;
    return this.remote("POST", `/edge/devices/${encodeURIComponent(device)}/disconnect`);
  }
  async revoke(device: string): Promise<EdgeCliEnvelope<unknown>> {
    const local = await this.localManagement({ command: "device-revoke", context: { tenantId: "default" }, deviceName: device });
    if (local) return local;
    return this.remote("POST", `/edge/devices/${encodeURIComponent(device)}/revoke`);
  }

  async installation(action: EdgeInstallationAction, deploymentId: string | undefined, options: { readonly cleanup?: boolean }): Promise<EdgeCliEnvelope<unknown>> {
    const credential = await this.platform.credentialStore.get("local-control-credential");
    if (!credential) return failure("EDGE_UNAVAILABLE", "The local Edge service is not running or has no control credential.");
    const response = await callEdgeLocalControl(
      { address: edgeLocalControlAddress(this.paths.dataDir), credential },
      `installation-${action}`,
      { ...(deploymentId ? { deploymentId } : {}), ...(options.cleanup ? { cleanup: true } : {}), ...(action === "cleanup" ? { approveCleanup: true } : {}) },
    );
    return response.ok ? success(response.data) : failure(response.error?.code ?? "EDGE_COMMAND_FAILED", response.error?.message ?? "Installation control failed.");
  }

  async approve(
    userCode: string,
    decision: { readonly tenantId: string; readonly subjectId: string; readonly actorId: string; readonly approvedAt: number },
  ): Promise<EdgeCliEnvelope<unknown>> {
    try {
      const project = await discoverProject(this.runtime.cwd);
      const stateDir = project.config.edge?.controlPlane?.stateDir ?? "edge-control-plane";
      const endpoint = await readEdgeLocalOperatorEndpoint(path.resolve(project.root, project.config.authDir, stateDir));
      const response = await new EdgeLocalOperatorClient(endpoint).request({ command: "approve", userCode, decision });
      if (!response.ok) {
        const code = response.error?.message.toLowerCase().includes("pending")
          ? "EDGE_AUTHORIZATION_CODE_EXPIRED"
          : normalizeControlPlaneErrorCode(response.error?.code);
        return failure(code, response.error?.message ?? "Local Edge approval failed.");
      }
      return success({
        status: "approved",
        userCode,
        tenantId: decision.tenantId,
        subjectId: decision.subjectId,
        actorId: decision.actorId,
      }, null, [], [{ description: "Wait for the Edge to finish enrollment", command: "fentaris edge status --json" }]);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        return failure("LOCAL_EDGE_AUTHORITY_UNAVAILABLE", "The protected local Edge operator channel is unavailable.");
      }
      throw error;
    }
  }

  private async localDiscoveryGate(options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown> | undefined> {
    if (!(await this.isLocalControlPlane())) return undefined;
    if (options.as?.startsWith("group:")) {
      return failure(
        "EDGE_CLI_USAGE",
        "Local Edge discovery supports --as user:<name> only; group selectors require a remote control plane.",
      );
    }
    return undefined;
  }

  private async isLocalControlPlane(): Promise<boolean> {
    try {
      const project = await discoverProject(this.runtime.cwd);
      return project.config.edge?.controlPlane?.mode === "local";
    } catch {
      return false;
    }
  }

  private async localManagement(request: EdgeLocalOperatorClientRequest): Promise<EdgeCliEnvelope<unknown> | undefined> {
    let project;
    try {
      project = await discoverProject(this.runtime.cwd);
    } catch {
      return undefined;
    }
    if (project.config.edge?.controlPlane?.mode !== "local") return undefined;
    try {
      const stateDir = project.config.edge.controlPlane.stateDir ?? "edge-control-plane";
      const endpoint = await readEdgeLocalOperatorEndpoint(path.resolve(project.root, project.config.authDir, stateDir));
      const response = await new EdgeLocalOperatorClient(endpoint).request(request);
      if (!response.ok) {
        return failure(normalizeControlPlaneErrorCode(response.error?.code), response.error?.message ?? "Local Edge management failed.");
      }
      return adaptLocalManagementEnvelope(response.data);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ECONNREFUSED") {
        return failure("LOCAL_EDGE_AUTHORITY_UNAVAILABLE", "The protected local Edge operator channel is unavailable.");
      }
      throw error;
    }
  }

  private async remote(method: string, route: string, body?: unknown, query: EdgeRemoteQuery = {}): Promise<EdgeCliEnvelope<unknown>> {
    const base = requiredEnvironment(this.runtime.env, "FENTARIS_EDGE_CONTROL_PLANE_URL");
    const url = new URL(route, base.endsWith("/") ? base : `${base}/`);
    addQuery(url, query);
    const response = await fetch(url, {
      method,
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(this.runtime.env.FENTARIS_EDGE_ACCESS_TOKEN ? { authorization: `Bearer ${this.runtime.env.FENTARIS_EDGE_ACCESS_TOKEN}` } : {}),
        ...(query.as ? { "x-fentaris-as": query.as } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as EdgeCliEnvelope<unknown>;
    if (!response.ok && value.ok) return failure("EDGE_CONTROL_PLANE_ERROR", `Control plane returned HTTP ${response.status}.`);
    return value;
  }

  private adapter() {
    return edgeServiceAdapter({
      serviceFile: process.platform === "darwin"
        ? path.join(process.env.HOME ?? this.paths.dataDir, "Library", "LaunchAgents", "dev.fentaris.edge.plist")
        : path.join(process.env.HOME ?? this.paths.dataDir, ".config", "systemd", "user", "fentaris-edge.service"),
      foregroundCommand: "fentaris edge run",
    });
  }

  private definition() {
    return { executable: process.execPath, args: [process.argv[1] ?? "fentaris", "edge", "run"] };
  }

  private async controlCredential(): Promise<string> {
    const existing = await this.platform.credentialStore.get("local-control-credential");
    if (existing) return existing;
    const created = createEdgeLocalControlCredential();
    await this.platform.credentialStore.set("local-control-credential", created);
    return created;
  }
}

function success<T>(
  data: T,
  pagination: { readonly nextCursor?: string } | null = null,
  warnings: readonly string[] = [],
  nextActions: readonly EdgeCliNextAction[] = [],
): EdgeCliEnvelope<T> {
  return { ok: true, data, pagination, warnings, nextActions };
}

function failure(code: string, message: string, details: Readonly<Record<string, unknown>> = {}): EdgeCliEnvelope<never> {
  return { ok: false, error: { code, message, details }, warnings: [], nextActions: [] };
}

function printEnvelope(runtime: Runtime, envelope: EdgeCliEnvelope<unknown>, options: CliOptions): void {
  if (options.json === true) {
    runtime.out.log(JSON.stringify(envelope, null, 2));
    return;
  }
  if (!envelope.ok) {
    runtime.out.error(`${envelope.error.code}: ${envelope.error.message}`);
    for (const action of envelope.nextActions) runtime.out.error(`Next: ${action.command}`);
    return;
  }
  if (Array.isArray(envelope.data)) {
    for (const item of envelope.data) runtime.out.log(formatHuman(item));
  } else {
    runtime.out.log(formatHuman(envelope.data));
  }
  for (const warning of envelope.warnings) runtime.out.error(`Warning: ${warning}`);
  for (const action of envelope.nextActions) runtime.out.log(`Next: ${action.command}`);
}

function printJoinVerification(runtime: Runtime, options: CliOptions, verification: EdgeJoinVerification): void {
  const approvalCommand = `fentaris edge approve ${shellArg(verification.userCode)} --subject <subject>`;
  if (options.json === true) {
    runtime.out.error(JSON.stringify({
      type: "edge.verification_required",
      data: verification,
      nextAction: { description: "Approve this Edge device", command: approvalCommand },
    }));
    return;
  }
  runtime.out.log(`Verification URL: ${verification.verificationUri}`);
  runtime.out.log(`User code: ${verification.userCode}`);
  runtime.out.log(`Approve with: ${approvalCommand}`);
}

function printFailure(
  runtime: Runtime,
  options: CliOptions,
  code: string,
  message: string,
  exitCode: number,
  nextActions: readonly EdgeCliNextAction[] = [],
): number {
  const envelope: EdgeCliEnvelope<never> = {
    ok: false,
    error: { code, message, details: {} },
    warnings: [],
    nextActions,
  };
  printEnvelope(runtime, envelope, options);
  return exitCode;
}

function formatHuman(value: unknown): string {
  if (!value || typeof value !== "object") return String(value);
  const item = value as Record<string, unknown>;
  const device = item.device as { name?: string } | undefined;
  return [device?.name ?? item.name, item.status ?? item.state, item.description].filter(Boolean).join(" ") || JSON.stringify(value);
}

async function confirmMutation(runtime: Runtime, options: CliOptions, action: string, device: string): Promise<boolean> {
  if (options.yes === true) return true;
  if (runtime.nonInteractive) return false;
  return runtime.prompt.confirm(`${action === "revoke" ? "Revoke" : "Disconnect"} Edge device "${device}"?`);
}

async function confirmInstallationMutation(runtime: Runtime, options: CliOptions, action: EdgeInstallationAction, deploymentId: string): Promise<boolean> {
  if (options.yes === true) return true;
  if (runtime.nonInteractive) return false;
  return runtime.prompt.confirm(`${action} managed installation for deployment "${deploymentId}"?`);
}

function remoteQuery(options: CliOptions): EdgeRemoteQuery {
  const as = stringOption(options, "as");
  if (as && !/^(user|group):[^:]+$/.test(as)) throw new Error("--as must use user:<name> or group:<name>.");
  return {
    compact: options.compact === true ? true : undefined,
    limit: numberOption(options, "limit"),
    cursor: stringOption(options, "cursor"),
    include: listOption(options, "include"),
    exclude: listOption(options, "exclude"),
    as,
  };
}

function managementContext(options: EdgeRemoteQuery): { tenantId: string; subjectId?: string } {
  const as = options.as;
  if (!as) return { tenantId: "default" };
  const subjectId = as.startsWith("user:") ? as.slice("user:".length) : as;
  return {
    tenantId: "default",
    ...(subjectId ? { subjectId } : {}),
  };
}

function adaptLocalManagementEnvelope(value: unknown): EdgeCliEnvelope<unknown> {
  if (!value || typeof value !== "object" || !("ok" in value)) {
    return failure("EDGE_CONTROL_PLANE_ERROR", "Local Edge management returned a malformed response.");
  }
  const result = value as {
    readonly ok: boolean;
    readonly data?: unknown;
    readonly pagination?: { readonly nextCursor?: string } | null;
    readonly warnings?: readonly unknown[];
    readonly nextActions?: readonly unknown[];
    readonly error?: { readonly code?: string; readonly message?: string; readonly details?: Readonly<Record<string, unknown>> };
  };
  const warnings = (result.warnings ?? []).map((warning) => String(warning));
  const nextActions = (result.nextActions ?? []).map(adaptLocalNextAction);
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: normalizeControlPlaneErrorCode(result.error?.code),
        message: result.error?.message ?? "Local Edge management failed.",
        details: result.error?.details ?? {},
      },
      warnings,
      nextActions,
    };
  }
  return {
    ok: true,
    data: result.data,
    pagination: result.pagination ?? null,
    warnings,
    nextActions,
  };
}

function adaptLocalNextAction(action: unknown): EdgeCliNextAction {
  if (action && typeof action === "object" && "description" in action && "command" in action) {
    const candidate = action as { description: unknown; command: unknown };
    return {
      description: String(candidate.description),
      command: String(candidate.command),
    };
  }
  const description = String(action);
  if (/reconnect/i.test(description)) {
    return { description, command: "fentaris edge run" };
  }
  if (/join again/i.test(description)) {
    return { description, command: "fentaris edge join <control-plane-url>" };
  }
  return { description, command: "fentaris edge status --json" };
}

function shapeLocalDiscovery(envelope: EdgeCliEnvelope<unknown>, options: EdgeRemoteQuery): EdgeCliEnvelope<unknown> {
  if (!envelope.ok) return envelope;
  const include = options.include ? new Set(options.include) : undefined;
  const exclude = options.exclude ? new Set(options.exclude) : undefined;
  const shape = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    const record = value as Record<string, unknown>;
    if (options.compact === true) {
      const device = record.device && typeof record.device === "object"
        ? record.device as Record<string, unknown>
        : undefined;
      return {
        device: device ? { name: device.name, inventoryVersion: device.inventoryVersion } : record.device,
        revoked: record.revoked,
        connected: record.connected,
        ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
      };
    }
    if (!include && !exclude) return value;
    const next: Record<string, unknown> = {
      schemaVersion: record.schemaVersion,
      device: record.device,
      revoked: record.revoked,
      connected: record.connected,
      ...(record.lastSeenAt === undefined ? {} : { lastSeenAt: record.lastSeenAt }),
    };
    for (const field of ["user", "observed", "managed"] as const) {
      if (exclude?.has(field)) continue;
      if (include && !include.has(field)) continue;
      if (record[field] !== undefined) next[field] = record[field];
    }
    if (!include || include.has("readiness")) {
      if (!exclude?.has("readiness") && record.readiness !== undefined) next.readiness = record.readiness;
    }
    return next;
  };
  if (Array.isArray(envelope.data)) {
    return { ...envelope, data: envelope.data.map(shape) };
  }
  return { ...envelope, data: shape(envelope.data) };
}

function addQuery(url: URL, query: EdgeRemoteQuery): void {
  if (query.compact) url.searchParams.set("compact", "true");
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  if (query.cursor) url.searchParams.set("cursor", query.cursor);
  if (query.include) url.searchParams.set("include", query.include.join(","));
  if (query.exclude) url.searchParams.set("exclude", query.exclude.join(","));
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listOption(options: CliOptions, key: string): string[] | undefined {
  return stringOption(options, key)?.split(",").map((value) => value.trim()).filter(Boolean);
}

function numberOption(options: CliOptions, key: string): number | undefined {
  const value = stringOption(options, key);
  if (!value || !/^\d+$/.test(value)) return undefined;
  return Number.parseInt(value, 10);
}

function requiredArg(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function requiredServiceOperation(value: string | undefined): EdgeServiceOperation {
  if (value === "install" || value === "start" || value === "stop" || value === "restart" || value === "uninstall") return value;
  throw new Error("edge service requires install, start, stop, restart, or uninstall.");
}

function requiredInstallationAction(value: string | undefined): EdgeInstallationAction {
  if (value === "status" || value === "review" || value === "approve" || value === "deny" || value === "retry" || value === "revoke" || value === "cleanup") return value;
  throw new Error("edge installation requires status, review, approve, deny, retry, revoke, or cleanup.");
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name];
  if (!value) throw new Error(`${name} is required for this command.`);
  return value;
}

function exitCodeFor(code: string): number {
  if (/UNAUTHORIZED|AUTH|GRANT/.test(code)) return 3;
  if (/UNAVAILABLE|CAPACITY/.test(code)) return 4;
  if (/CONFLICT/.test(code)) return 5;
  return 1;
}

async function confirmApproval(
  runtime: Runtime,
  options: CliOptions,
  userCode: string,
  subjectId: string,
  tenantId: string,
): Promise<boolean> {
  if (options.yes === true) return true;
  if (runtime.nonInteractive) return false;
  return runtime.prompt.confirm(`Approve Edge code "${userCode}" for subject "${subjectId}" in tenant "${tenantId}"?`);
}

function normalizeControlPlaneErrorCode(code: string | undefined): string {
  switch (code) {
    case "expired_token": return "EDGE_AUTHORIZATION_CODE_EXPIRED";
    case "access_denied": return "EDGE_JOIN_DENIED";
    case "unauthorized": return "EDGE_DEVICE_REVOKED";
    case "invalid_request": return "EDGE_CONTROL_PLANE_INVALID_CONFIGURATION";
    default:
      if (code && /^EDGE_[A-Z0-9_]+$/.test(code)) return code;
      return "EDGE_COMMAND_FAILED";
  }
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

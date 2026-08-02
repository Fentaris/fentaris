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

export interface EdgeCliNextAction {
  readonly description: string;
  readonly command: string;
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
  }): Promise<EdgeCliEnvelope<unknown>>;
  run(): Promise<EdgeCliEnvelope<unknown>>;
  service(operation: EdgeServiceOperation): Promise<EdgeCliEnvelope<unknown>>;
  list(options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  get(device: string, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  status(device: string | undefined, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>>;
  update(device: string, input: { expectedVersion: number; name?: string; description?: string; tags?: readonly string[] }): Promise<EdgeCliEnvelope<unknown>>;
  disconnect(device: string): Promise<EdgeCliEnvelope<unknown>>;
  revoke(device: string): Promise<EdgeCliEnvelope<unknown>>;
}

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
        });
        break;
      }
      case "run":
        envelope = await backend.run();
        break;
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
        verification.push({ verificationUri: request.verificationUri, userCode: request.userCode });
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
    const controlPlaneUrl = requiredEnvironment(this.runtime.env, "FENTARIS_EDGE_CONTROL_PLANE_URL");
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
    });
    await persistent.start();
    await control.start();
    try {
      await persistent.wait();
    } finally {
      await control.stop();
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
    return this.remote("GET", "/edge/devices", undefined, options);
  }
  async get(device: string, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>> {
    return this.remote("GET", `/edge/devices/${encodeURIComponent(device)}`, undefined, options);
  }
  async status(device: string | undefined, options: EdgeRemoteQuery): Promise<EdgeCliEnvelope<unknown>> {
    if (device) return this.remote("GET", `/edge/devices/${encodeURIComponent(device)}/status`, undefined, options);
    const credential = await this.platform.credentialStore.get("local-control-credential");
    if (credential) {
      try {
        const response = await callEdgeLocalControl({ address: edgeLocalControlAddress(this.paths.dataDir), credential }, "status");
        return response.ok ? success(response.data) : failure(response.error?.code ?? "EDGE_UNAVAILABLE", response.error?.message ?? "Local Edge status failed.");
      } catch {
        // Fall through to safe persisted/local status.
      }
    }
    const persisted = await new ProtectedJsonStore<EdgePersistentStatus>(path.join(this.paths.dataDir, "status.json")).load();
    return success(persisted ?? { state: "stopped" }, null, persisted ? [] : ["No persistent Edge runtime status is available."], [
      { description: "Run Edge in the foreground", command: "fentaris edge run" },
    ]);
  }
  async update(device: string, input: Parameters<EdgeOperatorBackend["update"]>[1]): Promise<EdgeCliEnvelope<unknown>> {
    return this.remote("PATCH", `/edge/devices/${encodeURIComponent(device)}`, input);
  }
  async disconnect(device: string): Promise<EdgeCliEnvelope<unknown>> {
    return this.remote("POST", `/edge/devices/${encodeURIComponent(device)}/disconnect`);
  }
  async revoke(device: string): Promise<EdgeCliEnvelope<unknown>> {
    return this.remote("POST", `/edge/devices/${encodeURIComponent(device)}/revoke`);
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

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

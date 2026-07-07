import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentToolDiscoveryService, type AgentJsonEnvelope, type McpProxyOptions } from "@fentaris/core";
import { discoverSecretsProject } from "../domain/project/project.js";
import type { CliCommand, CliOptions, Runtime } from "../shared/types.js";

export async function runTools(command: CliCommand, runtime: Runtime): Promise<void> {
  const subcommand = command.args[0];
  const service = await loadService(runtime);

  if (subcommand === "list") {
    print(runtime, await service.list(options(command.options)), command.options);
    return;
  }
  if (subcommand === "search") {
    const query = command.args[1];
    if (!query) {
      throw new Error("tools search requires a query.");
    }
    print(runtime, await service.search(query, options(command.options)), command.options);
    return;
  }
  if (subcommand === "get") {
    const tool = command.args[1];
    if (!tool) {
      throw new Error("tools get requires a tool name.");
    }
    print(runtime, await service.get(tool, options(command.options)), command.options);
    return;
  }
  if (subcommand === "schema") {
    const tool = command.args[1];
    if (!tool) {
      throw new Error("tools schema requires a tool name.");
    }
    print(runtime, await service.schema(tool, { ...options(command.options), input: command.options.input === true, output: command.options.output === true }), command.options);
    return;
  }
  if (subcommand === "auth") {
    await runToolsAuth(command, runtime, service);
    return;
  }

  throw new Error(`Unknown tools command "${subcommand ?? ""}".`);
}

async function runToolsAuth(command: CliCommand, runtime: Runtime, service: AgentToolDiscoveryService): Promise<void> {
  const action = command.args[1];
  if (action === "list") {
    print(runtime, service.authList(), command.options);
    return;
  }

  const mcp = stringOption(command.options, "mcp");
  const selector = stringOption(command.options, "as");
  if (!mcp || !selector) {
    throw new Error("tools auth status/login require --mcp and --as.");
  }
  if (action === "status") {
    print(runtime, service.authStatusEnvelope(mcp, selector), command.options);
    return;
  }
  if (action === "login") {
    print(runtime, service.authLogin(mcp, selector), command.options);
    return;
  }

  throw new Error(`Unknown tools auth command "${action ?? ""}".`);
}

function options(input: CliOptions) {
  return {
    mcp: stringOption(input, "mcp"),
    selector: stringOption(input, "as"),
    compact: input.compact === true ? true : undefined,
    limit: numberOption(input, "limit"),
    cursor: stringOption(input, "cursor"),
    maxTokens: numberOption(input, "max-tokens"),
    include: repeatableOption(input, "include"),
    exclude: repeatableOption(input, "exclude"),
    refresh: input.refresh === true,
    noStart: input["no-start"] === true,
  };
}

async function loadService(runtime: Runtime): Promise<AgentToolDiscoveryService> {
  const project = await discoverSecretsProject(runtime.cwd, { requireEntrypoint: true });
  const entrypoint = pathToFileURL(join(project.root, project.config.entrypoint)).href;
  const module = await import(`${entrypoint}?fentarisToolsDiscovery=${Date.now()}`) as Record<string, unknown>;
  const config = module.fentarisConfig ?? module.config ?? module.default;
  if (!config || typeof config !== "object") {
    throw new Error("Project entrypoint must export a Fentaris config as default, config, or fentarisConfig for tools discovery.");
  }
  return new AgentToolDiscoveryService(config as McpProxyOptions);
}

function print(runtime: Runtime, envelope: AgentJsonEnvelope<unknown>, opts: CliOptions): void {
  if (opts.json === true) {
    runtime.out.log(JSON.stringify(envelope, null, 2));
    return;
  }
  if (!envelope.ok) {
    throw new Error(`${envelope.error.code}: ${envelope.error.message}`);
  }
  if (Array.isArray(envelope.data)) {
    for (const item of envelope.data) {
      runtime.out.log(formatItem(item));
    }
    return;
  }
  runtime.out.log(formatItem(envelope.data));
}

function formatItem(item: unknown): string {
  if (item && typeof item === "object" && "name" in item) {
    const record = item as { name?: unknown; description?: unknown; authStatus?: unknown };
    return [record.name, record.authStatus ? `[${record.authStatus}]` : undefined, record.description].filter(Boolean).join(" ");
  }
  return JSON.stringify(item);
}

function stringOption(options: CliOptions, key: string): string | undefined {
  const value = options[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberOption(options: CliOptions, key: string): number | undefined {
  const value = stringOption(options, key);
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function repeatableOption(options: CliOptions, key: string): string[] | undefined {
  const value = stringOption(options, key);
  return value ? value.split(",").map((entry) => entry.trim()).filter(Boolean) : undefined;
}

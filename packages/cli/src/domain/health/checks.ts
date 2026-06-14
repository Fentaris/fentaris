import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { FentarisAuth } from "@fentaris/core";
import { authDir, supportedPackageManagers } from "../../shared/constants.js";
import type { HealthResult, PackageManager, ProjectConfig, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { canAccess, exists, isNodeError, readJson } from "../../shared/utils.js";

export type DoctorOptions = {
  fix?: boolean;
  runtime?: boolean;
  timeoutMs?: number;
};

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

type ConfigValidation = {
  config?: ProjectConfig;
  results: HealthResult[];
};

export async function getDoctorResults(runtime: Runtime, options: boolean | DoctorOptions = {}): Promise<HealthResult[]> {
  const normalized = normalizeDoctorOptions(options);
  const results: HealthResult[] = [
    ...environmentResults(runtime),
    await writableResult(runtime.cwd),
    await cliDirectoryResult(runtime.cwd),
  ];

  const project = await discoverProjectForDoctor(runtime.cwd);
  results.push(project.result);
  results.push(...(project.validationResults ?? []));

  if (project.discovery) {
    results.push(...await projectDiscoveryResults(project.discovery));
    const validation = await configResults(project.discovery);
    results.push(...validation.results);
    results.push(...await packageResults(project.discovery));
    results.push(...await authResults(project.discovery, runtime));
    results.push(await portResult(project.discovery.config.port));

    if (normalized.runtime) {
      results.push(await runtimeEndpointResult(project.discovery, runtime, normalized.timeoutMs));
    }
  } else if (normalized.runtime) {
    results.push({
      group: "Runtime",
      label: "runtime probe",
      status: "fail",
      detail: "Skipped because no Fentaris project was discovered.",
      hint: "Run doctor --runtime inside a generated Fentaris project.",
    });
  }

  if (normalized.fix) {
    for (const result of results.filter((item) => item.fix)) {
      if (await runtime.prompt.confirm(`Apply fix for ${result.label}?`)) {
        await result.fix?.();
      }
    }
  }

  return results;
}

export async function getProjectCheckResults(project: ProjectDiscovery, offline: boolean): Promise<HealthResult[]> {
  const expectedFiles = [
    "package.json",
    "tsconfig.json",
    "fentaris.json",
    ".env.example",
    ".gitignore",
    "README.md",
    project.config.entrypoint,
    path.join(project.config.authDir, "credentials.enc.json"),
  ];
  const results: HealthResult[] = [];

  for (const file of expectedFiles) {
    const fileExists = await exists(path.join(project.root, file));
    results.push({
      group: "Files",
      label: file,
      status: fileExists ? "pass" : "fail",
      detail: fileExists ? "Found" : "Missing",
    });
  }

  results.push(...(await configResults(project)).results);
  results.push(...await packageResults(project));
  results.push(...await authResults(project, undefined));

  if (!offline) {
    results.push(await portResult(project.config.port));
  }

  return results;
}

export function hasFailure(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "fail");
}

export function hasWarning(results: HealthResult[]): boolean {
  return results.some((result) => result.status === "warn");
}

function normalizeDoctorOptions(options: boolean | DoctorOptions): Required<DoctorOptions> {
  if (typeof options === "boolean") {
    return { fix: options, runtime: false, timeoutMs: 10_000 };
  }

  return {
    fix: options.fix === true,
    runtime: options.runtime === true,
    timeoutMs: normalizeTimeout(options.timeoutMs),
  };
}

function environmentResults(runtime: Runtime): HealthResult[] {
  return [
    {
      group: "Environment",
      label: "Node.js",
      status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail",
      detail: `Detected ${process.versions.node}; Fentaris requires Node 20 or newer.`,
    },
    ...supportedPackageManagers.map((manager): HealthResult => {
      const present = runtime.probe(manager, ["--version"]);
      return {
        group: "Environment",
        label: manager,
        status: present ? "pass" : "warn",
        detail: present ? "Available" : "Not found",
        hint: present ? undefined : `Install ${manager} or use a package manager that is available locally.`,
      };
    }),
    {
      group: "Environment",
      label: "git",
      status: runtime.probe("git", ["--version"]) ? "pass" : "fail",
      detail: runtime.probe("git", ["--version"]) ? "Available" : "Required for project initialization.",
    },
    {
      group: "Environment",
      label: "Docker",
      status: runtime.probe("docker", ["--version"]) ? "pass" : "warn",
      detail: runtime.probe("docker", ["--version"]) ? "Available" : "Optional for future container workflows.",
    },
  ];
}

async function discoverProjectForDoctor(fromDir: string): Promise<{ result: HealthResult; discovery?: ProjectDiscovery; validationResults?: HealthResult[] }> {
  let current = path.resolve(fromDir);
  while (true) {
    const configPath = path.join(current, "fentaris.json");
    if (await exists(configPath)) {
      const validation = await readAndValidateProjectConfig(configPath, current);
      if (!validation.config) {
        return {
          result: {
            group: "Project",
            label: "project root",
            status: "fail",
            detail: `Found ${configPath}, but it is not valid.`,
            hint: "Fix fentaris.json before running project commands.",
          },
          validationResults: validation.results,
        };
      }
      return {
        result: { group: "Project", label: "project root", status: "pass", detail: current },
        discovery: { root: current, configPath, config: validation.config },
      };
    }

    const legacyConfigPath = path.join(current, "fentaris.config.json");
    if (await exists(legacyConfigPath)) {
      const validation = await readAndValidateProjectConfig(legacyConfigPath, current);
      if (!validation.config) {
        return {
          result: {
            group: "Project",
            label: "project root",
            status: "fail",
            detail: `Found ${legacyConfigPath}, but it is not valid.`,
            hint: "Fix or migrate the legacy config before running project commands.",
          },
          validationResults: validation.results,
        };
      }
      return {
        result: {
          group: "Project",
          label: "project root",
          status: "warn",
          detail: current,
          hint: "Using legacy fentaris.config.json; rename it to fentaris.json before alpha publishing.",
        },
        discovery: { root: current, configPath: legacyConfigPath, config: validation.config },
      };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return {
        result: {
          group: "Project",
          label: "project root",
          status: "warn",
          detail: "No Fentaris project found from current directory.",
          hint: "Run this command inside a generated Fentaris project for project diagnostics.",
        },
      };
    }
    current = parent;
  }
}

async function projectDiscoveryResults(project: ProjectDiscovery): Promise<HealthResult[]> {
  const entrypointPath = path.join(project.root, project.config.entrypoint);
  const authPath = path.join(project.root, project.config.authDir);
  const generatedFiles = [
    "package.json",
    "tsconfig.json",
    ".env.example",
    ".gitignore",
    "README.md",
    project.config.entrypoint,
  ];

  const results: HealthResult[] = [
    {
      group: "Project",
      label: "config file",
      status: path.basename(project.configPath) === "fentaris.json" ? "pass" : "warn",
      detail: project.configPath,
      hint: path.basename(project.configPath) === "fentaris.json" ? undefined : "Rename the legacy config to fentaris.json.",
    },
    {
      group: "Project",
      label: "entrypoint",
      status: await exists(entrypointPath) ? "pass" : "fail",
      detail: project.config.entrypoint,
      hint: await exists(entrypointPath) ? undefined : "Create the configured entrypoint or update fentaris.json.",
    },
    {
      group: "Project",
      label: "auth directory",
      status: await exists(authPath) ? "pass" : "warn",
      detail: project.config.authDir,
      hint: await exists(authPath) ? undefined : "Run doctor --fix to create the configured auth directory.",
      fix: async () => {
        await mkdir(authPath, { recursive: true });
      },
    },
  ];

  for (const file of generatedFiles) {
    const filePath = path.join(project.root, file);
    const present = await exists(filePath);
    results.push({
      group: "Project",
      label: file,
      status: present ? "pass" : "warn",
      detail: present ? "Found" : "Missing",
      hint: present ? undefined : "Generated projects are expected to include this file.",
    });
  }

  return results;
}

async function configResults(project: ProjectDiscovery): Promise<ConfigValidation> {
  return readAndValidateProjectConfig(project.configPath, project.root);
}

async function readAndValidateProjectConfig(configPath: string, root: string): Promise<ConfigValidation> {
  const json = await readJsonResult(configPath);
  if (!json.ok) {
    return {
      results: [{
        group: "Config",
        label: path.basename(configPath),
        status: "fail",
        detail: json.message,
        hint: "Fix the JSON syntax before running Fentaris project commands.",
      }],
    };
  }

  if (!json.value || typeof json.value !== "object" || Array.isArray(json.value)) {
    return {
      results: [{
        group: "Config",
        label: path.basename(configPath),
        status: "fail",
        detail: "Config must be a JSON object.",
      }],
    };
  }

  const raw = json.value as Record<string, unknown>;
  const results: HealthResult[] = [];
  const name = stringField(raw, "name", results);
  const packageManager = packageManagerField(raw, results);
  const entrypoint = relativePathField(raw, "entrypoint", root, results);
  const port = portField(raw, results);
  const proxyPath = proxyPathField(raw, results);
  const configuredAuthDir = relativePathField(raw, "authDir", root, results);

  if (results.some((result) => result.status === "fail")) {
    return { results };
  }

  return {
    config: {
      name,
      packageManager,
      entrypoint,
      port,
      path: proxyPath,
      authDir: configuredAuthDir,
    },
    results: [
      {
        group: "Config",
        label: path.basename(configPath),
        status: "pass",
        detail: "JSON shape is valid.",
      },
      ...results,
    ],
  };
}

async function packageResults(project: ProjectDiscovery): Promise<HealthResult[]> {
  const packagePath = path.join(project.root, "package.json");
  const packageJson = await readJsonResult(packagePath);
  if (!packageJson.ok || !packageJson.value || typeof packageJson.value !== "object" || Array.isArray(packageJson.value)) {
    return [{
      group: "Package",
      label: "package.json",
      status: "fail",
      detail: packageJson.ok ? "package.json must be a JSON object." : packageJson.message,
      hint: "Create a valid package.json before running Fentaris scripts.",
    }];
  }

  const value = packageJson.value as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };
  const dependencies = { ...value.dependencies, ...value.devDependencies };
  const scripts = value.scripts ?? {};
  const results: HealthResult[] = [
    {
      group: "Package",
      label: "@fentaris/core",
      status: value.dependencies?.["@fentaris/core"] ? "pass" : "fail",
      detail: value.dependencies?.["@fentaris/core"] ? `Declared as ${value.dependencies["@fentaris/core"]}` : "Missing from dependencies.",
      hint: value.dependencies?.["@fentaris/core"] ? undefined : "Add @fentaris/core to dependencies, not only devDependencies.",
    },
    scriptResult(scripts, "dev"),
    scriptResult(scripts, "build"),
    {
      group: "Package",
      label: "start script",
      status: scripts.start ? "pass" : "warn",
      detail: scripts.start ? scripts.start : "Missing",
      hint: scripts.start ? undefined : "Useful for built runtime smoke checks, but not required for local dev.",
    },
    {
      group: "Package",
      label: "tsx",
      status: scripts.dev?.includes("tsx") && !dependencies.tsx ? "fail" : "pass",
      detail: scripts.dev?.includes("tsx") ? dependencies.tsx ? `Declared as ${dependencies.tsx}` : "dev script uses tsx but dependency is missing." : "Not required by dev script.",
    },
    {
      group: "Package",
      label: "typescript",
      status: scripts.build?.includes("tsc") && !dependencies.typescript ? "fail" : "pass",
      detail: scripts.build?.includes("tsc") ? dependencies.typescript ? `Declared as ${dependencies.typescript}` : "build script uses tsc but dependency is missing." : "Not required by build script.",
    },
    await tsconfigResult(project.root),
    await lockfileResult(project.root, project.config.packageManager),
  ];

  return results;
}

async function authResults(project: ProjectDiscovery, runtime: Runtime | undefined): Promise<HealthResult[]> {
  const authPath = path.join(project.root, project.config.authDir);
  const credentialsPath = path.join(authPath, "credentials.enc.json");
  const authDirectoryExists = await exists(authPath);
  const credentialsExist = await exists(credentialsPath);
  const key = runtime?.env.FENTARIS_AUTH_KEY;
  const results: HealthResult[] = [
    {
      group: "Auth",
      label: "local auth directory",
      status: authDirectoryExists ? "pass" : "warn",
      detail: authDirectoryExists ? project.config.authDir : "Missing",
      hint: authDirectoryExists ? undefined : "Run doctor --fix to create the configured auth directory.",
      fix: async () => {
        await mkdir(authPath, { recursive: true });
      },
    },
    {
      group: "Auth",
      label: "credentials.enc.json",
      status: credentialsExist ? "pass" : "warn",
      detail: credentialsExist ? "Found encrypted credential store." : "Missing encrypted credential store.",
      hint: credentialsExist ? undefined : "Run fentaris init or fentaris auth init to create local credentials.",
    },
    {
      group: "Auth",
      label: "FENTARIS_AUTH_KEY",
      status: key?.trim() ? "pass" : "warn",
      detail: key?.trim() ? "Set" : "Not set",
      hint: key?.trim() ? undefined : "Set FENTARIS_AUTH_KEY before decrypting local credentials. The value is never printed by doctor.",
    },
    await gitignoreAuthResult(project.root),
  ];

  if (credentialsExist && key?.trim()) {
    results.push(await credentialDecryptResult(credentialsPath, key));
  } else if (credentialsExist) {
    results.push({
      group: "Auth",
      label: "credential decrypt",
      status: "warn",
      detail: "Skipped because FENTARIS_AUTH_KEY is not set.",
      hint: "Set FENTARIS_AUTH_KEY to verify encrypted credentials locally.",
    });
  }

  return results;
}

async function runtimeEndpointResult(project: ProjectDiscovery, runtime: Runtime, timeoutMs: number): Promise<HealthResult> {
  const command = project.config.packageManager;
  const args = packageScriptArgs(project.config.packageManager, "dev");
  const child = spawn(command, args, {
    cwd: project.root,
    env: { ...process.env, ...runtime.env },
    stdio: "ignore",
  });
  let spawnError: Error | undefined;
  child.once("error", (error) => {
    spawnError = error;
  });

  try {
    const portOpen = await waitForPort(project.config.port, timeoutMs);
    if (!portOpen) {
      return {
        group: "Runtime",
        label: "dev server",
        status: "fail",
        detail: spawnError?.message ?? `Port ${project.config.port} did not open within ${timeoutMs}ms.`,
        hint: `${command} ${args.join(" ")} did not expose the configured port in time.`,
      };
    }

    const probe = await probeMcpEndpoint(project, runtime, timeoutMs);
    return probe;
  } finally {
    child.kill("SIGTERM");
  }
}

async function probeMcpEndpoint(project: ProjectDiscovery, runtime: Runtime, timeoutMs: number): Promise<HealthResult> {
  const url = `http://127.0.0.1:${project.config.port}${project.config.path}`;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream" };
  const apiKey = runtime.env.FENTARIS_GUEST_API_KEY ?? runtime.env.FENTARIS_ADMIN_API_KEY ?? runtime.env.FENTARIS_API_KEY;
  if (apiKey?.trim()) {
    headers["x-fentaris-api-key"] = apiKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "doctor-initialize",
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "fentaris-doctor", version: "0.1.0" },
        },
      }),
      signal: controller.signal,
    });

    if (response.ok) {
      return {
        group: "Runtime",
        label: "MCP initialize",
        status: "pass",
        detail: `Endpoint responded at ${url}`,
      };
    }

    return {
      group: "Runtime",
      label: "MCP initialize",
      status: response.status === 401 || response.status === 403 ? "warn" : "fail",
      detail: `Endpoint returned HTTP ${response.status}.`,
      hint: response.status === 401 || response.status === 403
        ? "Runtime is reachable but authentication failed. Provide FENTARIS_GUEST_API_KEY, FENTARIS_ADMIN_API_KEY, or FENTARIS_API_KEY."
        : "Check the configured path and runtime startup logs.",
    };
  } catch (error) {
    return {
      group: "Runtime",
      label: "MCP initialize",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: "The runtime port opened, but doctor could not complete an MCP initialize probe.",
    };
  } finally {
    clearTimeout(timer);
  }
}

async function writableResult(dir: string): Promise<HealthResult> {
  const writable = await canAccess(dir, fsConstants.W_OK);
  return {
    group: "Filesystem",
    label: "current directory",
    status: writable ? "pass" : "fail",
    detail: writable ? `Writable: ${dir}` : `Cannot write to ${dir}`,
  };
}

async function cliDirectoryResult(cwd: string): Promise<HealthResult> {
  const cliDir = path.join(cwd, ".fentaris");
  const present = await exists(cliDir);
  return {
    group: "Filesystem",
    label: "CLI local directory",
    status: present ? "pass" : "warn",
    detail: present ? `Found ${cliDir}` : `Missing ${cliDir}; doctor --fix can create it.`,
    fix: async () => {
      await mkdir(cliDir, { recursive: true });
    },
  };
}

async function portResult(port: number): Promise<HealthResult> {
  const available = await isPortAvailable(port);
  return {
    group: "Network",
    label: `localhost:${port}`,
    status: available ? "pass" : "warn",
    detail: available ? "Port is available." : "Port is already in use.",
    hint: available ? undefined : "Stop the conflicting process or change port in fentaris.json.",
  };
}

function scriptResult(scripts: Record<string, string>, name: string): HealthResult {
  return {
    group: "Package",
    label: `${name} script`,
    status: scripts[name] ? "pass" : "fail",
    detail: scripts[name] ?? "Missing",
  };
}

async function tsconfigResult(root: string): Promise<HealthResult> {
  const configPath = path.join(root, "tsconfig.json");
  const present = await exists(configPath);
  if (!present) {
    return {
      group: "Package",
      label: "tsconfig.json",
      status: "fail",
      detail: "Missing",
    };
  }

  const json = await readJsonResult(configPath);
  return {
    group: "Package",
    label: "tsconfig.json",
    status: json.ok ? "pass" : "fail",
    detail: json.ok ? "Valid JSON" : json.message,
  };
}

async function lockfileResult(root: string, packageManager: PackageManager): Promise<HealthResult> {
  const expected = packageManager === "pnpm" ? ["pnpm-lock.yaml"] : packageManager === "npm" ? ["package-lock.json"] : ["bun.lockb", "bun.lock"];
  const found = [];
  for (const file of expected) {
    if (await exists(path.join(root, file))) {
      found.push(file);
    }
  }

  return {
    group: "Package",
    label: "lockfile",
    status: found.length > 0 ? "pass" : "warn",
    detail: found.length > 0 ? found.join(", ") : `No ${packageManager} lockfile found.`,
    hint: found.length > 0 ? undefined : `Run ${packageManager} install to create the expected lockfile.`,
  };
}

async function gitignoreAuthResult(root: string): Promise<HealthResult> {
  const gitignorePath = path.join(root, ".gitignore");
  const present = await exists(gitignorePath);
  if (!present) {
    return {
      group: "Auth",
      label: ".gitignore auth entry",
      status: "warn",
      detail: ".gitignore is missing.",
      hint: "doctor --fix can create .gitignore with .fentaris/ ignored.",
      fix: async () => {
        await writeFile(gitignorePath, ".fentaris/\n");
      },
    };
  }

  const contents = await readFile(gitignorePath, "utf8");
  const ignoresAuth = contents.split(/\r?\n/).some((line) => line.trim() === ".fentaris/" || line.trim() === ".fentaris");
  return {
    group: "Auth",
    label: ".gitignore auth entry",
    status: ignoresAuth ? "pass" : "warn",
    detail: ignoresAuth ? ".fentaris/ is ignored." : ".fentaris/ is not ignored.",
    hint: ignoresAuth ? undefined : "doctor --fix can add .fentaris/ to .gitignore.",
    fix: async () => {
      await writeFile(gitignorePath, `${contents.trimEnd()}\n.fentaris/\n`);
    },
  };
}

async function credentialDecryptResult(credentialsPath: string, key: string): Promise<HealthResult> {
  try {
    const raw = JSON.parse(await readFile(credentialsPath, "utf8")) as unknown;
    FentarisAuth.decryptCredentials(raw, key);
    return {
      group: "Auth",
      label: "credential decrypt",
      status: "pass",
      detail: "Encrypted credentials can be decrypted.",
    };
  } catch (error) {
    return {
      group: "Auth",
      label: "credential decrypt",
      status: "fail",
      detail: error instanceof Error ? error.message : "Credential decrypt failed.",
      hint: "Verify FENTARIS_AUTH_KEY matches the local credential store. Secrets are not printed.",
    };
  }
}

async function readJsonResult(filePath: string): Promise<JsonReadResult> {
  try {
    return { ok: true, value: await readJson(filePath) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, message: "Missing" };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function stringField(raw: Record<string, unknown>, name: string, results: HealthResult[]): string {
  const value = raw[name];
  const valid = typeof value === "string" && value.trim().length > 0;
  results.push({
    group: "Config",
    label: name,
    status: valid ? "pass" : "fail",
    detail: valid ? value : "Missing or empty",
  });
  return valid ? value : "";
}

function packageManagerField(raw: Record<string, unknown>, results: HealthResult[]): PackageManager {
  const value = raw.packageManager;
  const valid = typeof value === "string" && supportedPackageManagers.includes(value as PackageManager);
  results.push({
    group: "Config",
    label: "packageManager",
    status: valid ? "pass" : "fail",
    detail: valid ? value : `Expected one of: ${supportedPackageManagers.join(", ")}`,
  });
  return valid ? value as PackageManager : "pnpm";
}

function relativePathField(raw: Record<string, unknown>, name: "entrypoint" | "authDir", root: string, results: HealthResult[]): string {
  const value = raw[name];
  const validString = typeof value === "string" && value.trim().length > 0;
  const absolute = validString ? path.resolve(root, value) : root;
  const insideRoot = absolute === root || absolute.startsWith(`${root}${path.sep}`);
  const relative = validString && !path.isAbsolute(value) && insideRoot && (name !== "authDir" || value !== ".");
  const status = relative ? "pass" : "fail";
  results.push({
    group: "Config",
    label: name,
    status,
    detail: validString ? value : "Missing or empty",
    hint: relative ? undefined : name === "authDir" && value === "." ? "authDir must not point at the project root." : `${name} must be a relative path inside the project root.`,
  });

  return relative ? value : name === "authDir" ? authDir : "";
}

function portField(raw: Record<string, unknown>, results: HealthResult[]): number {
  const value = raw.port;
  const valid = typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 65_535;
  results.push({
    group: "Config",
    label: "port",
    status: valid ? "pass" : "fail",
    detail: valid ? String(value) : "Expected an integer between 1 and 65535.",
  });
  return valid ? value : 4000;
}

function proxyPathField(raw: Record<string, unknown>, results: HealthResult[]): string {
  const value = raw.path;
  const valid = typeof value === "string" && /^\/(?!\/)(?!.*\/\/)(?!.*\s).*/.test(value);
  results.push({
    group: "Config",
    label: "path",
    status: valid ? "pass" : "fail",
    detail: valid ? value : "Expected a path like /mcp without spaces or duplicate slashes.",
  });
  return valid ? value : "/mcp";
}

function normalizeTimeout(value: number | undefined): number {
  return Number.isFinite(value) && value !== undefined && value > 0 ? value : 10_000;
}

function packageScriptArgs(packageManager: PackageManager, script: string): string[] {
  if (packageManager === "npm") {
    return ["run", script];
  }
  return script === "dev" ? ["dev"] : ["run", script];
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() >= deadline) {
          resolve(false);
        } else {
          setTimeout(attempt, 250);
        }
      });
    };
    attempt();
  });
}

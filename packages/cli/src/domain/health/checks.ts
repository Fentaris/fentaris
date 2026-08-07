import { constants as fsConstants } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { FentarisAuth } from "@fentaris/core";
import semver from "semver";
import { authDir, supportedPackageManagers } from "../../shared/constants.js";
import type { HealthResult, PackageManager, ProjectConfig, ProjectDiscovery, Runtime } from "../../shared/types.js";
import { canAccess, exists, isNodeError, readJson } from "../../shared/utils.js";
import { loadRequiredReferences, secretsDoctorHealthResults } from "../secrets/doctor.js";

function isValidatableRange(range: string): boolean {
  return semver.validRange(range.trim()) !== null;
}

function satisfiesInstalledRange(declaredRange: string, installedVersion: string): "pass" | "warn" | "skip" {
  if (declaredRange.startsWith("workspace:") || declaredRange.startsWith("file:") || declaredRange.startsWith("link:") || declaredRange.startsWith("portal:")) {
    return "skip";
  }
  if (declaredRange === "latest" || declaredRange === "next" || declaredRange === "beta" || declaredRange === "canary") {
    return "skip";
  }
  if (!isValidatableRange(declaredRange)) {
    return "skip";
  }
  if (!semver.valid(installedVersion)) {
    return "skip";
  }
  return semver.satisfies(installedVersion, declaredRange) ? "pass" : "warn";
}

export type DoctorOptions = {
  fix?: boolean;
  runtime?: boolean;
  timeoutMs?: number;
  strict?: boolean;
};

type JsonReadResult =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

type TextReadResult =
  | { ok: true; value: string }
  | { ok: false; message: string };

type ConfigValidation = {
  config?: ProjectConfig;
  results: HealthResult[];
};

export async function getDoctorResults(runtime: Runtime, options: boolean | DoctorOptions = {}): Promise<HealthResult[]> {
  const normalized = normalizeDoctorOptions(options);
  const project = await discoverProjectForDoctor(runtime.cwd);
  const results: HealthResult[] = [
    ...environmentResults(runtime, project.discovery?.config.packageManager),
    await writableResult(runtime.cwd),
    await cliDirectoryResult(runtime.cwd),
  ];

  results.push(project.result);
  results.push(...(project.validationResults ?? []));

  if (project.discovery) {
    results.push(...await projectDiscoveryResults(project.discovery));
    const validation = await configResults(project.discovery);
    results.push(...validation.results);
    results.push(...await proxyPolicyResults(project.discovery));
    results.push(...await packageResults(project.discovery));
    results.push(...await authResults(project.discovery, runtime, { strict: normalized.strict }));
    if (normalized.runtime) {
      results.push(await runtimeEndpointResult(project.discovery, runtime, normalized.timeoutMs));
      if (project.discovery.config.edge?.controlPlane?.enabled) {
        results.push(await edgeControlPlaneEndpointResult(project.discovery, normalized.timeoutMs));
      }
    } else {
      results.push(await portResult(project.discovery.config.port));
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

export async function getProjectCheckResults(project: ProjectDiscovery, offline: boolean, runtime?: Runtime): Promise<HealthResult[]> {
  const requiredFiles = [
    "package.json",
    "tsconfig.json",
    "fentaris.json",
    ".gitignore",
    "README.md",
    project.config.entrypoint,
  ];
  const results: HealthResult[] = [];

  for (const file of requiredFiles) {
    const fileExists = await exists(path.join(project.root, file));
    results.push({
      group: "Files",
      label: file,
      status: fileExists ? "pass" : "fail",
      detail: fileExists ? "Found" : "Missing",
    });
  }

  results.push(...(await configResults(project)).results);
  results.push(...await proxyPolicyResults(project));
  results.push(...await packageResults(project));
  results.push(...await authResults(project, runtime));

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
    return { fix: options, runtime: false, timeoutMs: 10_000, strict: false };
  }

  return {
    fix: options.fix === true,
    runtime: options.runtime === true,
    timeoutMs: normalizeTimeout(options.timeoutMs),
    strict: options.strict === true,
  };
}

function environmentResults(runtime: Runtime, configuredPackageManager?: PackageManager): HealthResult[] {
  return [
    {
      group: "Environment",
      label: "Node.js",
      status: Number(process.versions.node.split(".")[0]) >= 20 ? "pass" : "fail",
      detail: `Detected ${process.versions.node}; Fentaris requires Node 20 or newer.`,
    },
    ...packageManagerResults(runtime, configuredPackageManager),
    {
      group: "Environment",
      label: "git",
      status: runtime.probe("git", ["--version"]) ? "pass" : "warn",
      detail: runtime.probe("git", ["--version"]) ? "Available" : "Optional for project initialization and repository checks.",
    },
    {
      group: "Environment",
      label: "Docker",
      status: runtime.probe("docker", ["--version"]) ? "pass" : "warn",
      detail: runtime.probe("docker", ["--version"]) ? "Available" : "Optional for future container workflows.",
    },
  ];
}

function packageManagerResults(runtime: Runtime, configuredPackageManager?: PackageManager): HealthResult[] {
  if (configuredPackageManager) {
    const present = runtime.probe(configuredPackageManager, ["--version"]);
    return [{
      group: "Environment",
      label: configuredPackageManager,
      status: present ? "pass" : "fail",
      detail: present ? "Available" : `Required by fentaris.json but not found.`,
      hint: present ? undefined : `Install ${configuredPackageManager} or update packageManager in fentaris.json.`,
    }];
  }

  const available = supportedPackageManagers.filter((manager) => runtime.probe(manager, ["--version"]));
  return [{
    group: "Environment",
    label: "package manager",
    status: available.length > 0 ? "pass" : "fail",
    detail: available.length > 0 ? `Available: ${available.join(", ")}` : "No supported package manager found.",
    hint: available.length === 0 ? `Install one of: ${supportedPackageManagers.join(", ")}` : undefined,
  }];
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
  const scaffoldFiles = [
    "package.json",
    "tsconfig.json",
    ".gitignore",
    "README.md",
    project.config.entrypoint,
  ];
  const missing: string[] = [];
  for (const file of scaffoldFiles) {
    if (!(await exists(path.join(project.root, file)))) {
      missing.push(file);
    }
  }

  return [
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
      label: "scaffold files",
      status: missing.length === 0 ? "pass" : "warn",
      detail: missing.length === 0 ? "All expected files present." : `Missing: ${missing.join(", ")}`,
      hint: missing.length === 0 ? undefined : "Generated projects are expected to include these files.",
    },
  ];
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
  const edgeConfig = await edgeControlPlaneField(raw, proxyPath, configuredAuthDir, root, results);

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
      ...(edgeConfig ? { edge: { controlPlane: edgeConfig } } : {}),
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

async function edgeControlPlaneField(
  raw: Record<string, unknown>,
  proxyPath: string,
  configuredAuthDir: string,
  root: string,
  results: HealthResult[],
): Promise<NonNullable<ProjectConfig["edge"]>["controlPlane"] | undefined> {
  if (raw.edge === undefined) return undefined;
  if (!raw.edge || typeof raw.edge !== "object" || Array.isArray(raw.edge)) {
    results.push({ group: "Edge", label: "control plane config", status: "fail", detail: "edge must be an object." });
    return undefined;
  }
  const controlPlane = (raw.edge as Record<string, unknown>).controlPlane;
  if (controlPlane === undefined) return undefined;
  if (!controlPlane || typeof controlPlane !== "object" || Array.isArray(controlPlane)) {
    results.push({ group: "Edge", label: "control plane config", status: "fail", detail: "edge.controlPlane must be an object." });
    return undefined;
  }
  const value = controlPlane as Record<string, unknown>;
  const enabled = value.enabled === true;
  const mode = value.mode === "managed" ? "managed" : "local";
  const basePath = typeof value.basePath === "string" ? value.basePath : "/_fentaris/edge";
  const stateDir = typeof value.stateDir === "string" ? value.stateDir : "edge-control-plane";
  const publicOrigin = typeof value.publicOrigin === "string" ? value.publicOrigin : undefined;
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    results.push({ group: "Edge", label: "control plane enabled", status: "fail", detail: "edge.controlPlane.enabled must be a boolean." });
  }
  if (value.mode !== undefined && value.mode !== "local" && value.mode !== "managed") {
    results.push({ group: "Edge", label: "control plane mode", status: "fail", detail: "edge.controlPlane.mode must be local or managed." });
  }
  const validBase = /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]+$/.test(basePath) && basePath !== "/";
  results.push({
    group: "Edge",
    label: "control plane route",
    status: !validBase || pathsOverlap(basePath, proxyPath) ? "fail" : "pass",
    detail: !validBase ? "The Edge base path is invalid." : pathsOverlap(basePath, proxyPath) ? `Conflicts with MCP path ${proxyPath}.` : basePath,
    hint: !validBase || pathsOverlap(basePath, proxyPath) ? "Use a distinct non-root path such as /_fentaris/edge." : undefined,
  });
  if (publicOrigin) {
    let secure: boolean;
    try {
      const url = new URL(publicOrigin);
      secure = url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
    } catch {
      secure = false;
    }
    results.push({
      group: "Edge",
      label: "canonical public origin",
      status: secure ? "pass" : "fail",
      detail: secure ? publicOrigin : "Use HTTPS for non-loopback Edge origins.",
    });
  } else if (enabled) {
    results.push({
      group: "Edge",
      label: "canonical public origin",
      status: "warn",
      detail: "No explicit publicOrigin; only a loopback listener may derive it safely.",
    });
  }
  const stateSafe = !path.isAbsolute(stateDir) && !stateDir.split(/[\\/]+/).includes("..");
  const statePath = path.resolve(root, configuredAuthDir, stateDir);
  let ownerOnly = true;
  if (await exists(statePath) && process.platform !== "win32") {
    ownerOnly = ((await stat(statePath)).mode & 0o077) === 0;
  }
  results.push({
    group: "Edge",
    label: "local authority state",
    status: !stateSafe || !ownerOnly ? "fail" : mode === "local" && enabled ? "warn" : "pass",
    detail: !stateSafe ? "stateDir escapes the configured auth directory." : !ownerOnly ? "State directory permissions are not owner-only." : `${path.relative(root, statePath)} (${mode})`,
    hint: mode === "local" && enabled ? "Local mode is durable but single-process; use managed adapters for multi-instance deployments." : undefined,
  });
  if (enabled && mode === "managed") {
    results.push({
      group: "Edge",
      label: "managed adapters",
      status: "warn",
      detail: "Managed adapter guarantees are validated from the TypeScript runtime configuration at startup.",
    });
  }
  return { enabled, mode, basePath, stateDir, ...(publicOrigin ? { publicOrigin } : {}) };
}

function pathsOverlap(left: string, right: string): boolean {
  const normalize = (value: string) => `/${value.split("/").filter(Boolean).join("/")}`;
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function isLoopback(hostname: string): boolean {
  const value = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return value === "localhost" || value === "::1" || value.startsWith("127.");
}

async function installedCoreVersionResult(projectRoot: string, declaredRange: string | undefined): Promise<HealthResult> {
  if (!declaredRange) {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "warn",
      detail: "Not declared in dependencies.",
      hint: "Run fentaris init or add @fentaris/core to dependencies.",
    };
  }

  // The point of this check is to catch the F-004 silent-version-mismatch
  // problem: a generated project that pins a known range but the resolved
  // installed version does not satisfy it. We never claim pass/fail for
  // non-validatable ranges (dist tags, workspace/file references, git urls)
  // because we cannot validate them without running the package manager.

  const installedPath = path.join(projectRoot, "node_modules", "@fentaris", "core", "package.json");
  if (!(await exists(installedPath))) {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "warn",
      detail: `Declared as ${declaredRange}; not yet installed (node_modules/@fentaris/core is missing).`,
      hint: "Run the package manager install command (e.g. pnpm install) before running fentaris dev.",
    };
  }

  const installedJson = await readJsonResult(installedPath);
  if (!installedJson.ok || !installedJson.value || typeof installedJson.value !== "object") {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "warn",
      detail: "Installed version could not be read.",
      hint: "Reinstall @fentaris/core with the package manager.",
    };
  }

  const installedVersion = (installedJson.value as { version?: unknown }).version;
  if (typeof installedVersion !== "string") {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "warn",
      detail: "Installed version field is missing or not a string.",
      hint: "Reinstall @fentaris/core with the package manager.",
    };
  }

  if (!isValidatableRange(declaredRange)) {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "pass",
      detail: `Installed ${installedVersion}; declared as ${declaredRange} (range cannot be statically validated).`,
    };
  }

  const satisfaction = satisfiesInstalledRange(declaredRange, installedVersion);
  if (satisfaction === "warn") {
    return {
      group: "Package",
      label: "@fentaris/core installed",
      status: "warn",
      detail: `Installed ${installedVersion} does not satisfy declared range ${declaredRange}.`,
      hint: "Run the package manager install command (e.g. pnpm install) to refresh dependencies, or re-run fentaris init --core-version <range>.",
    };
  }
  return {
    group: "Package",
    label: "@fentaris/core installed",
    status: "pass",
    detail: `Installed ${installedVersion} satisfies declared range ${declaredRange}.`,
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
    await installedCoreVersionResult(project.root, value.dependencies?.["@fentaris/core"]),
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

async function proxyPolicyResults(project: ProjectDiscovery): Promise<HealthResult[]> {
  const entrypointPath = path.join(project.root, project.config.entrypoint);
  const source = await readEntrypoint(entrypointPath);
  if (!source.ok) {
    return [{
      group: "Security",
      label: "proxy policy",
      status: "warn",
      detail: "Skipped because the configured entrypoint could not be read.",
      hint: "Fix the entrypoint path so check and doctor can verify deny-by-default proxy policy controls.",
    }];
  }

  const hasGlobalPolicy = /\busePolicy\s*\(/.test(source.value) || /\bpolicy\s*:/.test(source.value);
  const hasGroupPolicy = /\bgroups\s*:/.test(source.value) || /\.group\s*\(/.test(source.value) || /\bgroup\s*\(/.test(source.value);
  const hasAllowAll = /\b(?:Policy\.)?allowAll\s*\(/.test(source.value);
  const controlled = hasGlobalPolicy || hasGroupPolicy || hasAllowAll;

  return [{
    group: "Security",
    label: "proxy policy",
    status: controlled ? "pass" : "warn",
    detail: controlled
      ? "Entrypoint declares proxy policy controls."
      : "No global policy, group policy, or explicit allow-all development policy detected.",
    hint: controlled
      ? undefined
      : "Fentaris denies proxy calls by default. Add a least-privilege policy or an explicit Policy.allowAll()/allowAll() policy for development-only open access.",
  }];
}

async function readEntrypoint(entrypointPath: string): Promise<TextReadResult> {
  try {
    return { ok: true, value: await readFile(entrypointPath, "utf8") };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) {
      return { ok: false, message: "Missing" };
    }
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

async function authResults(project: ProjectDiscovery, runtime: Runtime | undefined, options: { strict?: boolean } = {}): Promise<HealthResult[]> {
  const authPath = path.join(project.root, project.config.authDir);
  const credentialsPath = path.join(authPath, "credentials.enc.json");
  const authDirectoryExists = await exists(authPath);
  const credentialsExist = await exists(credentialsPath);
  const key = runtime?.env.FENTARIS_AUTH_KEY;
  const requiredSecretReferences = credentialsExist ? [] : await loadRequiredReferences(project);
  if (!credentialsExist && requiredSecretReferences.length === 0) {
    return [await gitignoreAuthResult(project.root, project.config.authDir)];
  }

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
      hint: credentialsExist ? undefined : "Run fentaris secrets set <reference> to create local credentials.",
    },
    {
      group: "Auth",
      label: "FENTARIS_AUTH_KEY",
      status: key?.trim() ? "pass" : "warn",
      detail: key?.trim() ? "Set" : "Not set",
      hint: key?.trim() ? undefined : "Set FENTARIS_AUTH_KEY before decrypting local credentials. The value is never printed by doctor.",
    },
    await gitignoreAuthResult(project.root, project.config.authDir),
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

  if (runtime) {
    const extended = await secretsDoctorHealthResults(project, runtime, { strict: options.strict });
    for (const result of extended) {
      if (result.label.startsWith("credentials.enc.json")) {
        continue;
      }
      if (!results.some((existing) => existing.label === result.label && existing.detail === result.detail)) {
        results.push(result);
      }
    }
  }

  return results;
}

async function runtimeEndpointResult(project: ProjectDiscovery, runtime: Runtime, timeoutMs: number): Promise<HealthResult> {
  const portOpen = await waitForPort(project.config.port, timeoutMs);
  if (!portOpen) {
    return {
      group: "Runtime",
      label: "MCP endpoint",
      status: "fail",
      detail: `Port ${project.config.port} did not accept connections within ${timeoutMs}ms.`,
      hint: `Start the project with ${project.config.packageManager} dev, then retry doctor --runtime.`,
    };
  }

  return probeMcpEndpoint(project, runtime, timeoutMs);
}

async function edgeControlPlaneEndpointResult(project: ProjectDiscovery, timeoutMs: number): Promise<HealthResult> {
  const controlPlane = project.config.edge?.controlPlane;
  if (!controlPlane?.enabled) {
    return {
      group: "Runtime",
      label: "Edge control plane",
      status: "pass",
      detail: "Integrated Edge control plane is disabled.",
    };
  }

  const origin = controlPlane.publicOrigin ?? `http://127.0.0.1:${project.config.port}`;
  const url = `${origin.replace(/\/$/, "")}${controlPlane.basePath ?? "/_fentaris/edge"}/device/verify`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return {
      group: "Runtime",
      label: "Edge control plane",
      status: response.ok ? "pass" : "fail",
      detail: response.ok ? `Enrollment and gateway routes responded at ${url}` : `Endpoint returned HTTP ${response.status}.`,
      hint: response.ok ? undefined : "Check edge.controlPlane.basePath, publicOrigin, and runtime startup logs.",
    };
  } catch (error) {
    return {
      group: "Runtime",
      label: "Edge control plane",
      status: "fail",
      detail: error instanceof Error ? error.message : String(error),
      hint: "The integrated Edge control-plane endpoint could not be reached.",
    };
  } finally {
    clearTimeout(timer);
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

async function gitignoreAuthResult(root: string, configuredAuthDir: string): Promise<HealthResult> {
  const gitignorePath = path.join(root, ".gitignore");
  const normalizedAuthDir = configuredAuthDir.replace(/\\/g, "/").replace(/\/+$/u, "");
  const gitignoreDirectoryEntry = `${normalizedAuthDir}/`;
  const gitignoreContentsEntry = `${normalizedAuthDir}/*`;
  const manifestEntry = `!${normalizedAuthDir}/secrets.manifest.json`;
  const present = await exists(gitignorePath);
  if (!present) {
    return {
      group: "Auth",
      label: ".gitignore auth entry",
      status: "warn",
      detail: ".gitignore is missing.",
      hint: `doctor --fix can create .gitignore with ${gitignoreContentsEntry} ignored.`,
      fix: async () => {
        await writeFile(gitignorePath, `${gitignoreContentsEntry}\n${manifestEntry}\n`);
      },
    };
  }

  const contents = await readFile(gitignorePath, "utf8");
  const ignoresAuth = contents
    .split(/\r?\n/)
    .some((line) => line.trim() === gitignoreDirectoryEntry || line.trim() === normalizedAuthDir || line.trim() === gitignoreContentsEntry);
  return {
    group: "Auth",
    label: ".gitignore auth entry",
    status: ignoresAuth ? "pass" : "warn",
    detail: ignoresAuth ? `${gitignoreContentsEntry} is ignored.` : `${gitignoreContentsEntry} is not ignored.`,
    hint: ignoresAuth ? undefined : `doctor --fix can add ${gitignoreContentsEntry} to .gitignore.`,
    fix: async () => {
      await writeFile(gitignorePath, `${contents.trimEnd()}\n${gitignoreContentsEntry}\n${manifestEntry}\n`);
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

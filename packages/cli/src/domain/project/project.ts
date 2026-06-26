import { readdir } from "node:fs/promises";
import path from "node:path";
import { supportedPackageManagers } from "../../shared/constants.js";
import type { ExecProbe, PackageManager, ProcessRunner, ProjectConfig, ProjectDiscovery, Prompt } from "../../shared/types.js";
import { exists, isNodeError, readJson } from "../../shared/utils.js";

export async function resolveProjectName(provided: string | undefined, prompt: Prompt): Promise<string> {
  const value = provided?.trim() || (await prompt.text("Project name"));
  if (!value.trim()) {
    throw new Error("Project name is required.");
  }

  if (!/^[a-zA-Z0-9._-]+$/.test(value)) {
    throw new Error("Project name may only contain letters, numbers, dots, underscores, and hyphens.");
  }

  return value;
}

export async function ensureEmptyTargetDirectory(targetDir: string): Promise<void> {
  try {
    const current = await readdir(targetDir);
    if (current.length > 0) {
      throw new Error(`Fentaris can only initialize into a new or empty directory: ${targetDir}`);
    }
  } catch (error: unknown) {
    if (isNodeError(error, "ENOENT")) {
      return;
    }

    throw error;
  }
}

export async function selectPackageManager(probe: ExecProbe, prompt: Prompt): Promise<PackageManager> {
  const available = supportedPackageManagers.filter((manager) => probe(manager, ["--version"]));
  if (available.length === 0) {
    throw new Error("No supported package manager found. Install pnpm, npm, or bun.");
  }

  if (available.length === 1) {
    return available[0];
  }

  return prompt.select("Package manager", available);
}

export async function discoverProject(fromDir: string): Promise<ProjectDiscovery> {
  const configured = await discoverConfiguredProject(fromDir);
  if (configured) {
    return configured;
  }

  throw new Error("No Fentaris project found. Run this command inside a generated Fentaris project.");
}

export type SecretsProjectDiscoveryOptions = {
  entrypoint?: string;
  requireEntrypoint?: boolean;
};

export async function discoverSecretsProject(fromDir: string, options: SecretsProjectDiscoveryOptions = {}): Promise<ProjectDiscovery> {
  const configured = await discoverConfiguredProject(fromDir);
  if (configured) {
    return withEntrypointOverride(configured, options.entrypoint);
  }

  const sdkOnly = await discoverSdkOnlyProject(fromDir, options);
  if (sdkOnly) {
    return sdkOnly;
  }

  throw new Error(
    [
      "No Fentaris project found.",
      "Run this command inside a generated Fentaris project or an SDK-only project that depends on @fentaris/core.",
      "For SDK-only apps, run `fentaris secrets manifest --entrypoint src/index.ts` or add `\"fentaris\": { \"entrypoint\": \"src/index.ts\" }` to package.json.",
    ].join(" "),
  );
}

async function discoverConfiguredProject(fromDir: string): Promise<ProjectDiscovery | undefined> {
  let current = path.resolve(fromDir);
  while (true) {
    const configPath = path.join(current, "fentaris.json");
    if (await exists(configPath)) {
      const config = validateProjectConfig(await readJson(configPath), configPath);
      return { root: current, configPath, config };
    }

    const legacyConfigPath = path.join(current, "fentaris.config.json");
    if (await exists(legacyConfigPath)) {
      const config = validateProjectConfig(await readJson(legacyConfigPath), legacyConfigPath);
      return { root: current, configPath: legacyConfigPath, config };
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

async function discoverSdkOnlyProject(fromDir: string, options: SecretsProjectDiscoveryOptions): Promise<ProjectDiscovery | undefined> {
  const packageJsonPath = await findPackageJson(fromDir);
  if (!packageJsonPath) {
    return undefined;
  }

  const packageJson = validatePackageJson(await readJson(packageJsonPath), packageJsonPath);
  if (!dependsOnFentarisCore(packageJson)) {
    return undefined;
  }

  const root = path.dirname(packageJsonPath);
  const configuredEntrypoint = stringField(packageJson.fentaris, "entrypoint");
  const entrypoint = options.entrypoint?.trim() || configuredEntrypoint || await inferSdkOnlyEntrypoint(root);
  if (!entrypoint && options.requireEntrypoint === true) {
    throw new Error(
      [
        "SDK-only Fentaris project detected, but no entrypoint was found.",
        "Run `fentaris secrets manifest --entrypoint src/index.ts` or add `\"fentaris\": { \"entrypoint\": \"src/index.ts\" }` to package.json.",
      ].join(" "),
    );
  }

  const authDir = stringField(packageJson.fentaris, "authDir") ?? ".fentaris";
  const host = stringField(packageJson.fentaris, "host");
  const config: ProjectConfig = {
    name: packageJson.name ?? path.basename(root),
    packageManager: await inferPackageManager(root),
    entrypoint: entrypoint ?? "src/index.ts",
    port: numberField(packageJson.fentaris, "port") ?? 4000,
    ...(host ? { host } : {}),
    path: stringField(packageJson.fentaris, "path") ?? "/mcp",
    authDir,
  };

  return { root, configPath: packageJsonPath, config };
}

async function findPackageJson(fromDir: string): Promise<string | undefined> {
  let current = path.resolve(fromDir);
  while (true) {
    const packageJsonPath = path.join(current, "package.json");
    if (await exists(packageJsonPath)) {
      return packageJsonPath;
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  fentaris?: Record<string, unknown>;
};

function validatePackageJson(value: unknown, packageJsonPath: string): PackageJson {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid package.json at ${packageJsonPath}`);
  }

  const input = value as PackageJson;
  return {
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name } : {}),
    dependencies: recordField(input, "dependencies"),
    devDependencies: recordField(input, "devDependencies"),
    peerDependencies: recordField(input, "peerDependencies"),
    optionalDependencies: recordField(input, "optionalDependencies"),
    ...(input.fentaris && typeof input.fentaris === "object" && !Array.isArray(input.fentaris) ? { fentaris: input.fentaris as Record<string, unknown> } : {}),
  };
}

function recordField(value: unknown, key: keyof PackageJson): Record<string, string> {
  const record = (value as Record<string, unknown>)[key as string];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return {};
  }
  return Object.fromEntries(Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

function dependsOnFentarisCore(packageJson: PackageJson): boolean {
  return [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ].some((dependencies) => Boolean(dependencies?.["@fentaris/core"]));
}

async function inferSdkOnlyEntrypoint(root: string): Promise<string | undefined> {
  for (const candidate of ["src/index.ts", "src/main.ts", "index.ts"]) {
    if (await exists(path.join(root, candidate))) {
      return candidate;
    }
  }
  return undefined;
}

async function inferPackageManager(root: string): Promise<PackageManager> {
  if (await exists(path.join(root, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (await exists(path.join(root, "bun.lockb")) || await exists(path.join(root, "bun.lock"))) {
    return "bun";
  }
  return "npm";
}

function withEntrypointOverride(project: ProjectDiscovery, entrypoint: string | undefined): ProjectDiscovery {
  const trimmed = entrypoint?.trim();
  if (!trimmed) {
    return project;
  }
  return { ...project, config: { ...project.config, entrypoint: trimmed } };
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim() ? field : undefined;
}

function numberField(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

export async function runPackageInstall(packageManager: PackageManager, cwd: string, runner: ProcessRunner): Promise<void> {
  const result = await runner(packageManager, ["install"], { cwd, stdio: "inherit" });
  if (result.code !== 0) {
    throw new Error(`${packageManager} install failed.`);
  }
}

export async function runPackageScript(packageManager: PackageManager, cwd: string, script: string, runner: ProcessRunner, env?: NodeJS.ProcessEnv): Promise<void> {
  const args = packageManager === "npm" ? ["run", script] : script === "dev" ? ["dev"] : ["run", script];
  const result = await runner(packageManager, args, { cwd, stdio: "inherit", env });
  if (result.code !== 0) {
    throw new Error(`${packageManager} ${script} failed.`);
  }
}

function validateProjectConfig(value: unknown, configPath: string): ProjectConfig {
  if (!value || typeof value !== "object") {
    throw new Error(`Invalid Fentaris config at ${configPath}`);
  }

  const config = value as Partial<ProjectConfig>;
  if (!config.name || !config.packageManager || !config.entrypoint || !config.port || !config.path || !config.authDir) {
    throw new Error(`Invalid Fentaris config at ${configPath}`);
  }

  if (!supportedPackageManagers.includes(config.packageManager)) {
    throw new Error(`Unsupported package manager in ${configPath}`);
  }

  return {
    name: config.name,
    packageManager: config.packageManager,
    entrypoint: config.entrypoint,
    port: config.port,
    ...(config.host ? { host: config.host } : {}),
    path: config.path,
    authDir: config.authDir,
    ...(config.secrets ? { secrets: config.secrets } : {}),
    ...(config.fentaris ? { fentaris: config.fentaris } : {}),
  };
}

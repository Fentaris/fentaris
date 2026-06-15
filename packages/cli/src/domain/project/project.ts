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
      throw new Error("No Fentaris project found. Run this command inside a generated Fentaris project.");
    }
    current = parent;
  }
}

export async function runPackageInstall(packageManager: PackageManager, cwd: string, runner: ProcessRunner): Promise<void> {
  const result = await runner(packageManager, ["install"], { cwd, stdio: "inherit" });
  if (result.code !== 0) {
    throw new Error(`${packageManager} install failed.`);
  }
}

export async function runPackageScript(packageManager: PackageManager, cwd: string, script: string, runner: ProcessRunner): Promise<void> {
  const args = packageManager === "npm" ? ["run", script] : script === "dev" ? ["dev"] : ["run", script];
  const result = await runner(packageManager, args, { cwd, stdio: "inherit" });
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
    path: config.path,
    authDir: config.authDir,
  };
}

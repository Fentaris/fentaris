import { ProjectVault } from "@fentaris/core";
import type { ProjectDiscovery, Runtime } from "../../shared/types.js";
import { loadProjectEnv } from "../project/env.js";
/** Stable peer entry point. Opening never creates a vault or prompts. */
export async function openProjectVault(project: ProjectDiscovery, runtime: Runtime): Promise<ProjectVault> {
  return ProjectVault.open({ root: project.root, dir: project.config.authDir, env: await loadProjectEnv(project.root, runtime.env), ...(runtime.vaultOptions ?? {}) });
}

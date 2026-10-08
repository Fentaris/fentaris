import path from "node:path";
import { type ProjectSecretMetadata, type ProjectVault } from "@fentaris/core";
import type { ProjectDiscovery } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { scanEntrypointForSecrets } from "./manifest-scan.js";

/** Include explicit configuration sources without registering, migrating, or changing a binding. */
export async function inspectProjectSecrets(project: ProjectDiscovery, vault: ProjectVault, env: NodeJS.ProcessEnv, offline: boolean): Promise<ProjectSecretMetadata[]> {
  const inventory = await vault.inventory({ offline });
  const entrypoint = path.join(project.root, project.config.entrypoint);
  if (!(await exists(entrypoint))) return inventory;
  const configuration = await scanEntrypointForSecrets(entrypoint);
  for (const entry of configuration.references) {
    if (entry.source?.type !== "vault" && entry.source?.type !== "env") continue;
    const reference = entry.source.type === "vault" ? entry.source.reference ?? entry.ref : entry.ref;
    const existing = inventory.find((item) => item.reference === reference);
    if (existing) {
      if (!existing.consumers.some((consumer) => consumer.kind === "configuration" && consumer.server === "project-config")) existing.consumers.push({ kind: "configuration", server: "project-config" });
      continue;
    }
    const source = entry.source.type === "vault" ? { type: "vault" as const } : { type: "environment" as const, name: entry.source.name };
    const present = source.type === "environment" && Boolean(env[source.name]);
    inventory.push({ reference, source, present, state: present ? "present" : "missing", consumers: [{ kind: "configuration", server: "project-config" }], remoteValidity: "unverified", nextActions: present ? [] : [source.type === "vault" ? `fentaris secrets set ${reference}` : `Set ${source.name} in the process environment or project .env.`] });
  }
  return inventory.sort((a, b) => a.reference.localeCompare(b.reference));
}

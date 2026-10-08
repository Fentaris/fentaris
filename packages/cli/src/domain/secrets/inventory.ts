import path from "node:path";
import { type ProjectSecretMetadata, type ProjectVault } from "@fentaris/core";
import type { ProjectDiscovery } from "../../shared/types.js";
import { exists } from "../../shared/utils.js";
import { scanEntrypointForSecrets } from "./manifest-scan.js";

export type ConfiguredSecretMetadata = ProjectSecretMetadata & { configurationScopes?: string[] };

/** Include explicit configuration sources without registering, migrating, or changing a binding. */
export async function inspectProjectSecrets(project: ProjectDiscovery, vault: ProjectVault, env: NodeJS.ProcessEnv, offline: boolean): Promise<ConfiguredSecretMetadata[]> {
  const inventory: ConfiguredSecretMetadata[] = await vault.inventory({ offline });
  const registered = new Map(inventory.map((entry) => [entry.reference, entry]));
  const entrypoint = path.join(project.root, project.config.entrypoint);
  if (!(await exists(entrypoint))) return inventory;
  const configuration = await scanEntrypointForSecrets(entrypoint);
  for (const entry of configuration.references) {
    if (entry.source?.type !== "vault" && entry.source?.type !== "env") continue;
    const reference = entry.source.type === "vault" ? entry.source.reference ?? entry.ref : entry.ref;
    const unsupported = configuration.diagnostics.find((diagnostic) => diagnostic.ref === entry.ref && diagnostic.scope === entry.scope);
    if (unsupported) {
      inventory.push({ reference, source: { type: "vault" }, present: false, state: "unresolvable", consumers: [{ kind: "configuration", server: "project-config" }], configurationScopes: [entry.scope], remoteValidity: "unverified", nextActions: [unsupported.detail] });
      continue;
    }
    const environmentName = entry.source.type === "env" ? entry.source.name : undefined;
    // A vault helper follows its registered binding; a direct env helper must
    // independently check that exact variable, even under the same logical name.
    const existing = entry.source.type === "vault"
      ? registered.get(reference) ?? inventory.find((item) => item.reference === reference && item.source.type === "vault")
      : inventory.find((item) => item.reference === reference && item.source.type === "environment" && item.source.name === environmentName);
    if (existing) {
      if (!existing.consumers.some((consumer) => consumer.kind === "configuration" && consumer.server === "project-config")) existing.consumers.push({ kind: "configuration", server: "project-config" });
      existing.configurationScopes ??= [];
      if (!existing.configurationScopes.includes(entry.scope)) existing.configurationScopes.push(entry.scope);
      continue;
    }
    const source = entry.source.type === "vault" ? { type: "vault" as const } : { type: "environment" as const, name: entry.source.name };
    const present = source.type === "environment" && Boolean(env[source.name]);
    inventory.push({ reference, source, present, state: present ? "present" : "missing", consumers: [{ kind: "configuration", server: "project-config" }], configurationScopes: [entry.scope], remoteValidity: "unverified", nextActions: present ? [] : [source.type === "vault" ? `fentaris secrets set ${reference}` : `Set ${source.name} in the process environment or project .env.`] });
  }
  return inventory.sort((a, b) => a.reference.localeCompare(b.reference));
}

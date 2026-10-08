import { readFile } from "node:fs/promises";
import path from "node:path";
import { exists } from "../shared/utils.js";
import { assertVaultName } from "@fentaris/core";
import { discoverSecretsProject } from "../domain/project/project.js";
import { openProjectVault } from "../domain/secrets/vault.js";
import { chooseAction, commandResult, completeInput } from "../shared/input.js";
import type { CliCommand, Runtime } from "../shared/types.js";

export async function runIncomingAuth(command: CliCommand, runtime: Runtime): Promise<void> {
  const [family, suppliedAction, suppliedId] = command.args;
  const options = command.options;
  if (typeof options.user === "string") assertVaultName(options.user, "User");
  if (typeof options.name === "string") assertVaultName(options.name, "Key name");
  if (family && family !== "keys") throw new Error("Use fentaris auth keys for incoming client access. Upstream authentication belongs to fentaris mcp auth (#297).");
  const project = await discoverSecretsProject(runtime.cwd);
  const vault = await openProjectVault(project, runtime);
  if (!family) {
    const keys = await vault.keys();
    const entrypoint = path.join(project.root, project.config.entrypoint);
    const configuration = await exists(entrypoint) ? await readFile(entrypoint, "utf8") : "";
    const declared = [...configuration.matchAll(/\buser\s*\(\s*["']([A-Za-z0-9][A-Za-z0-9._-]{0,127})["']/gu)].map((match) => match[1]!);
    const users = [...new Set([...declared, ...keys.map((key) => key.user)])].map((user) => ({ user, activeKeyCount: keys.filter((key) => key.user === user && !key.revokedAt && (!key.expiresAt || Date.parse(key.expiresAt) > Date.now())).length }));
    commandResult(runtime, options, { users }, ["Incoming identities", ...users.map((entry) => `${entry.user}  ${entry.activeKeyCount} active key(s)`), ...(users.length ? [] : ["No incoming identities. Next: fentaris auth keys create --user <user> --name <name>"])]);
    return;
  }
  const action = suppliedAction ?? (await chooseAction(runtime, options, ["Create", "List", "Revoke"], "fentaris auth keys <create|list|revoke> --help")).toLowerCase();
  if (action === "create") {
    const fields = await completeInput(runtime, options, [{ name: "user", value: options.user, label: "User" }, { name: "name", value: options.name, label: "Name" }], "fentaris auth keys create --user <user> --name <name>");
    const expires = options.expires === true ? (await completeInput(runtime, options, [{ name: "expires", value: options.expires, label: "Expiry" }], "Pass --expires <future ISO 8601 UTC timestamp>.")).expires : options.expires;
    const result = await vault.createKey(fields.user!, fields.name!, typeof expires === "string" ? expires : undefined);
    // This is the sole sensitive result. No logging middleware or inventory receives it.
    commandResult(runtime, options, { key: result.key, sensitiveValue: result.sensitiveValue, sensitive: true, message: "Copy the value now; it will not be shown again." }, [`Created key ${result.key.id} for ${result.key.user}.`, "Sensitive client key. Copy the value now; it will not be shown again.", result.sensitiveValue]);
    return;
  }
  if (action === "list") {
    const user = options.user === true ? (await completeInput(runtime, options, [{ name: "user", value: options.user, label: "User" }], "fentaris auth keys list --user <user>")).user : typeof options.user === "string" ? options.user : undefined;
    const keys = await vault.keys(user);
    const rows = keys.map((key) => `${key.id}  ${key.name}  ${key.user}  ${key.createdAt}  ${key.expiresAt ?? "No expiry"}  ${key.revokedAt ? "Revoked" : key.expiresAt && Date.parse(key.expiresAt) <= Date.now() ? "Expired" : "Active"}`);
    commandResult(runtime, options, { keys }, ["KEY ID  NAME  USER  CREATED  EXPIRY  STATUS", ...rows, ...(keys.length ? [] : ["No keys. Next: fentaris auth keys create --user <user> --name <name>"])]);
    return;
  }
  if (action === "revoke") {
    const { id } = await completeInput(runtime, options, [{ name: "id", value: suppliedId, label: "Key ID" }], "fentaris auth keys revoke <key-id>");
    const key = await vault.revokeKey(id!);
    commandResult(runtime, options, { key }, [`Revoked key ${key.id} for ${key.user}.`]);
    return;
  }
  throw new Error("Unknown incoming key action. Use Create, List, or Revoke.");
}

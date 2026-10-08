import { readFile } from "node:fs/promises";
import { text as readStreamText } from "node:stream/consumers";
import { assertVaultName, type ProjectSecretSource, type ProjectSecretMetadata } from "@fentaris/core";
import { discoverSecretsProject } from "../domain/project/project.js";
import { inspectProjectSecrets } from "../domain/secrets/inventory.js";
import { openProjectVault } from "../domain/secrets/vault.js";
import { canPrompt, chooseAction, commandResult, completeInput, CommandInputError } from "../shared/input.js";
import type { CliCommand, Runtime } from "../shared/types.js";

export async function runVaultSecrets(command: CliCommand, runtime: Runtime): Promise<number> {
  const [suppliedAction, suppliedReference] = command.args;
  const options = command.options;
  const action = suppliedAction ?? "list";
  if (suppliedReference !== undefined) assertVaultName(suppliedReference, "Secret reference");
  const project = await discoverSecretsProject(runtime.cwd);
  const vault = await openProjectVault(project, runtime);
  if (["list", "get", "check"].includes(action)) {
    let references = await inspectProjectSecrets(project, vault, runtime.env, options.offline === true);
    if (action === "get") {
      const { reference } = await completeInput(runtime, options, [{ name: "reference", value: suppliedReference, label: "Secret reference" }], "fentaris secrets get <reference> --offline");
      references = references.filter((entry) => entry.reference === reference);
      if (!references.length) throw new Error("Secret reference was not found. Run fentaris secrets to inspect registered references.");
    }
    const problems = references.filter((entry) => entry.state !== "present" && entry.state !== "unverified");
    const data = action === "get" ? { secret: references[0] } : { secrets: references, remoteValidity: "unverified", ...(action === "check" ? { issues: problems } : {}) };
    const rows = references.map((entry) => `${entry.reference}  ${sourceLabel(entry)}  ${entry.state}  ${entry.consumers.map((item) => `${item.server}${item.account ? ` (${item.account})` : ""}`).join(", ") || "—"}`);
    commandResult(runtime, options, data, ["SECRET  SOURCE  STATUS  USED BY", ...rows, ...(references.length ? [] : ["No secret references. Next: fentaris secrets set <reference> --stdin"]), "Remote validity: unverified.", ...problems.flatMap((entry) => entry.nextActions)], action !== "check" || problems.length === 0);
    // A bare inventory may offer an explicit action only after displaying the read-only view.
    if (!suppliedAction && canPrompt(runtime, options)) {
      const selected = await chooseAction(runtime, options, ["Done", "Set", "Get", "Remove", "Check"], "fentaris secrets <set|get|remove|check>");
      if (selected !== "Done") return runVaultSecrets({ ...command, args: [selected.toLowerCase()] }, runtime);
    }
    return action === "check" && problems.length ? 1 : 0;
  }
  if (action === "set") {
    if (options.source === true) options.source = (await completeInput(runtime, options, [{ name: "source", value: options.source, label: "Source (vault/environment/external)" }], "Use --source vault, environment, or external.")).source!;
    if (options.source !== undefined && !["vault", "environment", "external"].includes(String(options.source))) throw new Error("--source must be vault, environment, or external.");
    const source = typeof options.source === "string" ? options.source : "vault";
    if (source !== "vault" && options.stdin) throw new Error("--stdin is only valid for a vault source. Values are never copied between sources.");
    if (source === "vault" && (options.env !== undefined || options.provider !== undefined || options.locator !== undefined)) throw new Error("Source options conflict. Environment and external locators require their explicit source.");
    if (source === "environment" && (options.provider !== undefined || options.locator !== undefined)) throw new Error("External options conflict with the environment source.");
    if (source === "external" && options.env !== undefined) throw new Error("--env conflicts with the external source.");
    const fields = await completeInput(runtime, options, [{ name: "reference", value: suppliedReference, label: "Secret reference" },
      ...(source === "environment" ? [{ name: "env", value: options.env, label: "Environment variable" }] : []),
      ...(source === "external" ? [{ name: "provider", value: options.provider, label: "External provider" }, { name: "locator", value: options.locator, label: "External locator" }] : [])], "fentaris secrets set <reference> --stdin; or --source environment --env <VARIABLE>");
    const reference = fields.reference!;
    assertVaultName(reference, "Secret reference");
    const configured = (await inspectProjectSecrets(project, vault, runtime.env, true)).find((entry) => entry.reference === reference);
    const consumer = configured?.consumers.find((entry) => entry.kind === "configuration");
    if (source !== "vault") {
      const binding: ProjectSecretSource = source === "environment" ? { type: "environment", name: fields.env! } : { type: "external", provider: fields.provider!, locator: fields.locator! };
      await vault.bind(reference, binding, { replaceSource: options["replace-source"] === true, consumer });
      commandResult(runtime, options, { reference, source: binding, stored: true, remoteValidity: "unverified" }, [`Bound ${reference} to ${source}. Remote validity: unverified. No credential value was copied.`]);
      return 0;
    }
    let value: string;
    if (options.stdin) value = (await readStreamText(runtime.stdin ?? process.stdin)).replace(/\r?\n$/, "");
    else value = (await completeInput(runtime, options, [{ name: "value", value: undefined, label: "Secret value", secret: true }], `fentaris secrets set ${reference} --stdin`)).value!;
    await vault.set(reference, value, { replaceSource: options["replace-source"] === true, consumer });
    commandResult(runtime, options, { reference, stored: true, remoteValidity: "unverified" }, [`Stored ${reference}. Remote validity: unverified.`]);
    return 0;
  }
  if (action === "remove") {
    const { reference } = await completeInput(runtime, options, [{ name: "reference", value: suppliedReference, label: "Secret reference" }], "fentaris secrets remove <reference> --force");
    const metadata = (await inspectProjectSecrets(project, vault, runtime.env, true)).find((entry) => entry.reference === reference);
    if (!metadata) throw new Error("Secret reference was not found.");
    let force = options.force === true;
    if (metadata.consumers.length && !force) {
      if (!canPrompt(runtime, options)) throw new CommandInputError(["destructiveChoice"], [`Affected consumers: ${metadata.consumers.map((item) => `${item.server} (${item.account ?? "default"})`).join(", ")}. Run fentaris secrets remove ${reference} --force to delete the value.`]);
      runtime.out.log(`Affected consumers: ${metadata.consumers.map((item) => `${item.server} (${item.account ?? "default"})`).join(", ")}`);
      force = await runtime.prompt.confirm("Remove this credential value and leave affected connections unresolved?");
      if (!force) { commandResult(runtime, options, { reference, removed: false, cancelled: true }, ["Removal cancelled. Credential was preserved."]); return 0; }
    }
    const consumers = await vault.remove(reference!, { force });
    commandResult(runtime, options, { reference, removed: true, consumers }, [`Removed the stored value for ${reference}. Its reference and consumers are retained for recovery.`]);
    return 0;
  }
  if (action === "migrate") {
    const fields = await completeInput(runtime, options, [{ name: "mapping", value: options.mapping, label: "Mapping file" }, { name: "legacy-file", value: options["legacy-file"], label: "Legacy encrypted file" }], "fentaris secrets migrate --mapping <file> --legacy-file <file> --non-interactive (configure FENTARIS_AUTH_KEY and FENTARIS_VAULT_KEY)");
    const key = runtime.env.FENTARIS_AUTH_KEY;
    if (!key) throw new CommandInputError(["FENTARIS_AUTH_KEY"], ["Configure the existing legacy unlock key. It will never be regenerated."]);
    let mappings: unknown;
    try { mappings = JSON.parse(await readFile(fields.mapping!, "utf8")); } catch { throw new Error("Unable to read the explicit migration mapping JSON."); }
    if (!Array.isArray(mappings) || mappings.some((entry) => !entry || typeof entry.reference !== "string" || typeof entry.target !== "string" || !/^(default|user:.+|group:.+)$/.test(entry.scope))) throw new Error("Mapping must be an array of {reference, scope, target} entries; scoped legacy values are never interpreted as account aliases.");
    const result = await vault.migrateLegacy({ file: fields["legacy-file"]!, key, mappings, incomingKeys: options["incoming-keys"] === true });
    commandResult(runtime, options, result, ["Migration written and verified. Legacy encrypted data and unlock key were preserved. Update configuration explicitly before retiring the legacy store."]);
    return 0;
  }
  throw new Error("Unknown secrets action. Use set, get, list, remove, check, or migrate.");
}
function sourceLabel(entry: ProjectSecretMetadata): string {
  return entry.source.type === "vault" ? "Local vault" : entry.source.type === "environment" ? `Environment (${entry.source.name})` : `External (${entry.source.provider})`;
}

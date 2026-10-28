import { readConfig, writeConfig } from "../config.js";
import { openCredentialStore } from "../credentials.js";
import { ClientError } from "../errors.js";
import type { CommandContext } from "../framework.js";
import { table, type CommandResult } from "../output.js";

export async function profileList(context: CommandContext): Promise<CommandResult> {
  const config = await readConfig(context.runtime);
  const store = await openCredentialStore(context.runtime);
  const profiles: Array<{ name: string; url: string; method: string; active: boolean; loggedIn: boolean }> = [];
  for (const [name, profile] of Object.entries(config.profiles).sort(([left], [right]) => left.localeCompare(right))) {
    profiles.push({ name, url: profile.url, method: profile.method, active: name === config.activeProfile, loggedIn: Boolean(await store.get(name)) });
  }
  return {
    data: { activeProfile: config.activeProfile ?? null, profiles },
    pagination: { limit: profiles.length, cursor: null, nextCursor: null, total: profiles.length },
    nextActions: profiles.length ? [] : [{ description: "Sign in to a Fentaris proxy", command: "frs auth login <url>" }],
    human: () => profiles.length
      ? table(profiles.map((profile) => [`${profile.active ? "*" : " "} ${profile.name}`, profile.url, profile.method, profile.loggedIn ? "yes" : "no"]), ["  PROFILE", "URL", "METHOD", "LOGGED IN"])
      : "No profiles. Run frs auth login <url>.",
  };
}

export async function profileUse(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  const config = await readConfig(context.runtime);
  if (!config.profiles[name]) throw missing(name);
  config.activeProfile = name;
  await writeConfig(context.runtime, config);
  return { data: { activeProfile: name, url: config.profiles[name].url }, human: () => `Active profile: ${name} (${config.profiles[name]!.url}).` };
}

export async function profileRemove(context: CommandContext): Promise<CommandResult> {
  const name = context.args[0]!;
  const config = await readConfig(context.runtime);
  if (!config.profiles[name]) throw missing(name);
  if (context.options.yes !== true) {
    if (context.global.nonInteractive) throw new ClientError("INVALID_ARGUMENTS", `Removing profile "${name}" deletes its stored credentials; confirm with --yes.`, {}, [{ description: "Confirm the removal", command: `frs profile remove ${name} --yes` }]);
    if (!await context.runtime.confirm(`Remove profile "${name}" and its stored credentials?`)) throw new ClientError("INVALID_ARGUMENTS", "Removal cancelled; nothing was changed.");
  }
  const store = await openCredentialStore(context.runtime);
  await store.delete(name);
  delete config.profiles[name];
  if (config.activeProfile === name) delete config.activeProfile;
  await writeConfig(context.runtime, config);
  return { data: { profile: name, removed: true, activeProfile: config.activeProfile ?? null }, human: () => `Removed profile "${name}".` };
}

function missing(name: string): ClientError {
  return new ClientError("NOT_FOUND", `Profile "${name}" does not exist.`, {}, [{ description: "List profiles", command: "frs profile list" }]);
}

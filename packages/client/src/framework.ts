import { ClientError } from "./errors.js";
import type { CommandResult } from "./output.js";
import type { Runtime } from "./runtime.js";

export type OptionSpec = { name: string; short?: string; value?: string; repeatable?: boolean; description: string };
export type ArgumentSpec = { name: string; required?: boolean; description: string };
export type Options = Record<string, string | boolean | string[] | undefined>;

export type GlobalOptions = { json: boolean; profile?: string; timeoutMs: number; nonInteractive: boolean };
export type CommandContext = { runtime: Runtime; argv: string[]; args: string[]; options: Options; global: GlobalOptions };

export type CommandSpec = {
  name: string;
  path: string[];
  summary: string;
  description?: string;
  usage: string;
  args?: ArgumentSpec[];
  options?: OptionSpec[];
  examples?: string[];
  children?: CommandSpec[];
  run?: (context: CommandContext) => Promise<CommandResult>;
};

export type ParseResult =
  | { kind: "run"; command: CommandSpec; args: string[]; options: Options }
  | { kind: "help"; command: CommandSpec }
  | { kind: "version" };

export const DEFAULT_TIMEOUT_MS = 120_000;

export const GLOBAL_OPTIONS: OptionSpec[] = [
  { name: "json", description: "Print one canonical JSON envelope on stdout." },
  { name: "profile", value: "NAME", description: "Use a named profile instead of the active one." },
  { name: "timeout", value: "MS", description: `Request timeout in milliseconds (1-3600000). [default: ${DEFAULT_TIMEOUT_MS}]` },
  { name: "non-interactive", description: "Never open a browser or prompt; fail with an actionable error instead." },
  { name: "help", short: "h", description: "Print help." },
  { name: "version", short: "v", description: "Print the version." },
];

export function parse(argv: string[], root: CommandSpec): ParseResult {
  let command = root;
  const args: string[] = [];
  const options: Options = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index]!;
    if (token === "--") { args.push(...argv.slice(index + 1)); break; }
    if (token.startsWith("--") || (/^-[a-zA-Z]$/.test(token))) {
      const [rawName, inline] = token.startsWith("--") ? splitInline(token.slice(2)) : [token.slice(1), undefined];
      const spec = [...(command.options ?? []), ...GLOBAL_OPTIONS].find((option) => option.name === rawName || option.short === rawName);
      if (!spec) throw usage(`Unknown option "${token}" for "${commandLabel(command)}".`, command);
      if (spec.value) {
        const value = inline ?? argv[++index];
        if (value === undefined || (inline === undefined && value.startsWith("--"))) throw usage(`Option --${spec.name} requires a ${spec.value} value.`, command);
        if (spec.repeatable) options[spec.name] = [...((options[spec.name] as string[] | undefined) ?? []), value];
        else if (options[spec.name] !== undefined) throw usage(`Option --${spec.name} was given more than once.`, command);
        else options[spec.name] = value;
      } else {
        if (inline !== undefined) throw usage(`Option --${spec.name} does not take a value.`, command);
        options[spec.name] = true;
      }
      continue;
    }
    if (!args.length && command.children?.length) {
      const child = command.children.find((candidate) => candidate.name === token);
      if (!child) throw new ClientError("UNKNOWN_COMMAND", `Unknown command "${[...command.path, token].join(" ")}". Available: ${command.children.map((candidate) => candidate.name).join(", ")}.`, {}, [{ description: "Show available commands", command: `${commandLabel(command)} --help` }]);
      command = child;
      continue;
    }
    args.push(token);
  }
  if (options.version === true) return { kind: "version" };
  if (options.help === true || !command.run) return { kind: "help", command };
  const specs = command.args ?? [];
  const required = specs.filter((arg) => arg.required).length;
  if (args.length < required) throw usage(`Missing required argument <${specs[args.length]!.name}>.`, command);
  if (args.length > specs.length) throw usage(`Unexpected argument "${args[specs.length]}".`, command);
  return { kind: "run", command, args, options };
}

export function globalOptions(options: Options, runtime: Runtime): GlobalOptions {
  const timeout = options.timeout;
  if (timeout !== undefined && (typeof timeout !== "string" || !/^\d+$/.test(timeout) || Number(timeout) < 1 || Number(timeout) > 3_600_000)) {
    throw new ClientError("INVALID_ARGUMENTS", "--timeout must be an integer from 1 to 3600000 milliseconds.");
  }
  const profile = typeof options.profile === "string" ? options.profile : runtime.env.FENTARIS_PROFILE || undefined;
  return {
    json: options.json === true,
    profile,
    timeoutMs: timeout ? Number(timeout) : DEFAULT_TIMEOUT_MS,
    nonInteractive: options["non-interactive"] === true || !runtime.interactive,
  };
}

export function renderHelp(command: CommandSpec): string {
  const lines = [command.description ?? command.summary, "", `Usage: ${command.usage}`];
  if (command.children?.length) {
    lines.push("", "Commands:");
    const width = Math.max(...command.children.map((child) => child.name.length));
    for (const child of command.children) lines.push(`  ${child.name.padEnd(width)}  ${child.summary}`);
  }
  if (command.args?.length) {
    lines.push("", "Arguments:");
    const width = Math.max(...command.args.map((arg) => arg.name.length + 2));
    for (const arg of command.args) lines.push(`  ${`<${arg.name}>`.padEnd(width)}  ${arg.description}${arg.required ? "" : " (optional)"}`);
  }
  const section = (title: string, specs: OptionSpec[]) => {
    if (!specs.length) return;
    const labels = specs.map((option) => `${option.short ? `-${option.short}, ` : "    "}--${option.name}${option.value ? ` <${option.value}>` : ""}`);
    const width = Math.max(...labels.map((label) => label.length));
    lines.push("", `${title}:`);
    specs.forEach((option, index) => lines.push(`  ${labels[index]!.padEnd(width)}  ${option.description}${option.repeatable ? " Repeatable." : ""}`));
  };
  section("Options", command.options ?? []);
  section("Global options", GLOBAL_OPTIONS);
  if (command.examples?.length) lines.push("", "Examples:", ...command.examples.map((example) => `  $ ${example}`));
  return `${lines.join("\n")}\n`;
}

export function stringOption(options: Options, name: string): string | undefined {
  const value = options[name];
  return typeof value === "string" ? value : undefined;
}

export function listOption(options: Options, name: string): string[] {
  const value = options[name];
  return Array.isArray(value) ? value : [];
}

export function integerOption(options: Options, name: string, fallback: number, max: number): number {
  const value = options[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) throw new ClientError("INVALID_ARGUMENTS", `--${name} must be an integer from 1 to ${max}.`);
  return Number(value);
}

function splitInline(value: string): [string, string | undefined] {
  const separator = value.indexOf("=");
  return separator < 0 ? [value, undefined] : [value.slice(0, separator), value.slice(separator + 1)];
}

function commandLabel(command: CommandSpec): string {
  return ["frs", ...command.path].join(" ");
}

function usage(message: string, command: CommandSpec): ClientError {
  return new ClientError("INVALID_ARGUMENTS", message, {}, [{ description: "Show usage", command: `${commandLabel(command)} --help` }]);
}

import { cliSpec, type CliCommandSpec, type CliOptionSpec } from "./cli-spec.js";
import type { CliOptions, ParseResult } from "./types.js";

export function parseCommand(argv: string[]): ParseResult {
  const global = extractGlobalOptions(argv);
  if (global.kind === "parse-error") {
    return { kind: "parse-error", message: global.message, path: [] };
  }
  const parsedArgv = global.argv;

  if (argv.length > 0 && parsedArgv.length === 0) {
    return { kind: "parse-error", message: "expected a command", path: [] };
  }

  if (parsedArgv.length === 0) {
    return { kind: "help", path: [] };
  }

  const [first, ...rest] = parsedArgv;
  if (first === "version") {
    return rest.length === 0 ? { kind: "version" } : { kind: "parse-error", message: `unexpected argument '${rest[0]}' found`, path: [] };
  }

  if (first === "help") {
    return parseHelp(rest);
  }

  const progressive = cliSpec.commands?.[first]?.progressive === true;
  const pathResult = progressive ? resolveProgressivePath(parsedArgv) : resolveCommandPath(parsedArgv);
  if (pathResult.kind === "parse-error") {
    return pathResult;
  }

  const { spec, path, remaining } = pathResult;
  const parsed = parseOptionsAndArgs(spec, remaining);
  if (parsed.kind === "parse-error") {
    return { ...parsed, path };
  }

  if (parsed.help) {
    return { kind: "help", path };
  }

  if (path.length === 0 && parsed.version) {
    return { kind: "version" };
  }

  if (path.length === 0) {
    return { kind: "parse-error", message: "expected a command", path: [] };
  }

  if (spec.commands && parsed.args.length === 0 && spec.allowNoSubcommand !== true) {
    return { kind: "parse-error", message: "expected a command", path };
  }

  const missing = (spec.arguments ?? []).find((argument, index) => argument.required === true && !parsed.args[index]);
  if (missing && !spec.progressive) {
    return { kind: "parse-error", message: `the following required arguments were not provided: <${missing.name}>`, path };
  }

  return {
    kind: "ok",
    path,
    command: {
      name: path[0] ?? "help",
      args: path.slice(1).concat(parsed.args),
      options: {
        ...parsed.options,
        ...(global.json ? { json: true } : {}),
        ...(global.nonInteractive ? { "non-interactive": true } : {}),
      },
    },
  };
}

function extractGlobalOptions(argv: string[]): { kind: "ok"; argv: string[]; nonInteractive: boolean; json: boolean } | { kind: "parse-error"; message: string } {
  const parsedArgv: string[] = [];
  let nonInteractive = false;
  let json = false;
  let passthrough = false;

  for (const token of argv) {
    if (passthrough) {
      parsedArgv.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      parsedArgv.push(token);
      continue;
    }

    if (token === "--json") { json = true; continue; }
    if (token.startsWith("--json=")) return { kind: "parse-error", message: "--json does not take a value" };
    if (token === "--non-interactive") {
      nonInteractive = true;
      continue;
    }

    if (token.startsWith("--non-interactive=")) {
      return { kind: "parse-error", message: `unexpected argument '${token.split('=')[0]}' found` };
    }

    parsedArgv.push(token);
  }

  return { kind: "ok", argv: parsedArgv, nonInteractive, json };
}

function resolveProgressivePath(argv: string[]): ReturnType<typeof resolveCommandPath> {
  const root = cliSpec.commands![argv[0]];
  const allOptions: CliOptionSpec[] = [];
  const collect = (spec: CliCommandSpec) => { allOptions.push(...(spec.options ?? [])); for (const child of Object.values(spec.commands ?? {})) collect(child); };
  collect(root);
  const flags: string[] = [];
  const positionals: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("-")) {
      flags.push(token);
      const name = token.replace(/^--?/, "").split("=")[0];
      const option = allOptions.find((entry) => entry.name === name || entry.short === name);
      if (option?.valueName && !token.includes("=") && argv[i + 1] !== undefined && !argv[i + 1].startsWith("-")) flags.push(argv[++i]);
    } else positionals.push(token);
  }
  let spec = root;
  const path = [argv[0]];
  while (positionals.length && spec.commands?.[positionals[0]]) { const name = positionals.shift()!; path.push(name); spec = spec.commands![name]; }
  if (positionals.length && !spec.arguments?.length) return { kind: "parse-error", message: `unrecognized subcommand '${positionals[0]}'`, path };
  if (positionals.length > (spec.arguments?.length ?? 0)) return { kind: "parse-error", message: `unexpected argument '${positionals[(spec.arguments?.length ?? 0)]}' found`, path };
  return { kind: "ok", spec, path, remaining: [...positionals, ...flags] };
}

function parseHelp(args: string[]): ParseResult {
  const path: string[] = [];
  let spec = cliSpec;

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      return { kind: "help", path };
    }
    if (arg.startsWith("-")) {
      return { kind: "parse-error", message: `unexpected argument '${arg}' found`, path };
    }
    const next = spec.commands?.[arg];
    if (!next) {
      return { kind: "parse-error", message: `unrecognized subcommand '${arg}'`, path };
    }
    spec = next;
    path.push(arg);
  }

  return { kind: "help", path };
}

function resolveCommandPath(argv: string[]):
  | { kind: "ok"; spec: CliCommandSpec; path: string[]; remaining: string[] }
  | { kind: "parse-error"; message: string; path: string[] } {
  let spec = cliSpec;
  const path: string[] = [];
  let index = 0;

  while (index < argv.length) {
    const arg = argv[index];
    if (arg === "--" || arg.startsWith("-")) {
      break;
    }

    const next = spec.commands?.[arg];
    if (!next) {
      return { kind: "parse-error", message: `unrecognized subcommand '${arg}'`, path };
    }

    spec = next;
    path.push(arg);
    index += 1;

    const following = argv[index];
    if (!following || following === "--" || following.startsWith("-")) {
      break;
    }

    if (!spec.commands?.[following]) {
      if (spec.commands) {
        return { kind: "parse-error", message: `unrecognized subcommand '${following}'`, path };
      }
      break;
    }
  }

  return { kind: "ok", spec, path, remaining: argv.slice(index) };
}

function parseOptionsAndArgs(spec: CliCommandSpec, tokens: string[]):
  | { kind: "ok"; args: string[]; options: CliOptions; help: boolean; version: boolean }
  | { kind: "parse-error"; message: string } {
  const args: string[] = [];
  const options: CliOptions = {};
  let help = false;
  let version = false;
  let passthrough = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (passthrough) {
      args.push(token);
      continue;
    }

    if (token === "--") {
      passthrough = true;
      continue;
    }

    if (!token.startsWith("-") || token === "-") {
      if (spec.commands?.[token]) {
        return { kind: "parse-error", message: `unexpected argument '${token.split('=')[0]}' found` };
      }
      args.push(token);
      continue;
    }

    const parsedOption = findOption(spec, token);
    if (!parsedOption) {
      return { kind: "parse-error", message: `unexpected argument '${token.split('=')[0]}' found` };
    }

    const { option, inlineValue, hasInlineValue } = parsedOption;
    if (option.name === "help") {
      help = true;
    }
    if (option.name === "version") {
      version = true;
    }

    if (options[option.name] !== undefined && !option.repeatable) return { kind: "parse-error", message: `option --${option.name} was supplied more than once` };
    if (option.valueName) {
      const value = hasInlineValue ? inlineValue : tokens[index + 1];
      if (value === undefined || (!hasInlineValue && (value.startsWith("--") || (spec.progressive === true && value.startsWith("-"))))) {
        if (spec.progressive === true) { options[option.name] = true; continue; }
        return { kind: "parse-error", message: `a value is required for '${token}' but none was supplied` };
      }
      if (value === "" && !spec.progressive) return { kind: "parse-error", message: `invalid empty value for --${option.name}` };
      const existing = options[option.name];
      if (existing !== undefined && !option.repeatable) return { kind: "parse-error", message: `option --${option.name} was supplied more than once` };
      options[option.name] = option.repeatable && typeof existing === "string"
        ? `${existing},${value}`
        : value;
      if (!hasInlineValue) {
        index += 1;
      }
    } else {
      if (hasInlineValue) {
        return { kind: "parse-error", message: `unexpected argument '${token.split('=')[0]}' found` };
      }
      options[option.name] = true;
    }
  }

  if (args.length > (spec.arguments?.length ?? 0)) return { kind: "parse-error", message: "unexpected positional argument; run --help for the command syntax" };
  return { kind: "ok", args, options, help, version };
}

function findOption(
  spec: CliCommandSpec,
  token: string,
): { option: CliOptionSpec; inlineValue: string | undefined; hasInlineValue: boolean } | undefined {
  const options = optionsForSpec(spec);
  if (token.startsWith("--")) {
    const body = token.slice(2);
    const separator = body.indexOf("=");
    const name = separator === -1 ? body : body.slice(0, separator);
    const option = options.find((candidate) => candidate.name === name);
    if (!option) {
      return undefined;
    }

    return {
      option,
      inlineValue: separator === -1 ? undefined : body.slice(separator + 1),
      hasInlineValue: separator !== -1,
    };
  }

  if (token.startsWith("-") && token.length === 2) {
    const short = token.slice(1);
    const option = options.find((candidate) => candidate.short === short);
    return option ? { option, inlineValue: undefined, hasInlineValue: false } : undefined;
  }

  return undefined;
}

function optionsForSpec(spec: CliCommandSpec): CliOptionSpec[] {
  const localOptions = spec.options ?? [];
  const localNames = new Set(localOptions.map((option) => option.name));
  const inheritedOptions = (cliSpec.options ?? [])
    .filter((option) => option.name === "non-interactive")
    .filter((option) => !localNames.has(option.name));
  return [...localOptions, ...inheritedOptions];
}

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

  const pathResult = resolveCommandPath(parsedArgv);
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
  if (missing) {
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
        ...(global.nonInteractive ? { "non-interactive": true } : {}),
      },
    },
  };
}

function extractGlobalOptions(argv: string[]): { kind: "ok"; argv: string[]; nonInteractive: boolean } | { kind: "parse-error"; message: string } {
  const parsedArgv: string[] = [];
  let nonInteractive = false;
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

    if (token === "--non-interactive") {
      nonInteractive = true;
      continue;
    }

    if (token.startsWith("--non-interactive=")) {
      return { kind: "parse-error", message: `unexpected argument '${token}' found` };
    }

    parsedArgv.push(token);
  }

  return { kind: "ok", argv: parsedArgv, nonInteractive };
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
        return { kind: "parse-error", message: `unexpected argument '${token}' found` };
      }
      args.push(token);
      continue;
    }

    const parsedOption = findOption(spec, token);
    if (!parsedOption) {
      return { kind: "parse-error", message: `unexpected argument '${token}' found` };
    }

    const { option, inlineValue, hasInlineValue } = parsedOption;
    if (option.name === "help") {
      help = true;
    }
    if (option.name === "version") {
      version = true;
    }

    if (option.valueName) {
      const value = hasInlineValue ? inlineValue : tokens[index + 1];
      if (value === undefined) {
        return { kind: "parse-error", message: `a value is required for '${token}' but none was supplied` };
      }
      options[option.name] = value;
      if (!hasInlineValue) {
        index += 1;
      }
    } else {
      if (hasInlineValue) {
        return { kind: "parse-error", message: `unexpected argument '${token}' found` };
      }
      options[option.name] = true;
    }
  }

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

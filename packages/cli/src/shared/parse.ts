import { cliSpec, type CliCommandSpec, type CliOptionSpec } from "./cli-spec.js";
import type { CliOptions, ParseResult } from "./types.js";

export function parseCommand(argv: string[]): ParseResult {
  if (argv.length === 0) {
    return { kind: "help", path: [] };
  }

  const [first, ...rest] = argv;
  if (first === "version") {
    return rest.length === 0 ? { kind: "version" } : { kind: "parse-error", message: `unexpected argument '${rest[0]}' found`, path: [] };
  }

  if (first === "help") {
    return parseHelp(rest);
  }

  const pathResult = resolveCommandPath(argv);
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

  if (spec.commands && parsed.args.length === 0) {
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
      options: parsed.options,
    },
  };
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

    const option = findOption(spec, token);
    if (!option) {
      return { kind: "parse-error", message: `unexpected argument '${token}' found` };
    }

    if (option.name === "help") {
      help = true;
    }
    if (option.name === "version") {
      version = true;
    }

    if (option.valueName) {
      const value = tokens[index + 1];
      if (!value || value === "--" || value.startsWith("-")) {
        return { kind: "parse-error", message: `a value is required for '${token}' but none was supplied` };
      }
      options[option.name] = value;
      index += 1;
    } else {
      options[option.name] = true;
    }
  }

  return { kind: "ok", args, options, help, version };
}

function findOption(spec: CliCommandSpec, token: string): CliOptionSpec | undefined {
  const options = spec.options ?? [];
  if (token.startsWith("--")) {
    const name = token.slice(2);
    return options.find((option) => option.name === name);
  }

  if (token.startsWith("-") && token.length === 2) {
    const short = token.slice(1);
    return options.find((option) => option.short === short);
  }

  return undefined;
}

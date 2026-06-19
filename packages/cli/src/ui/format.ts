import type { HealthResult, HealthStatus, Runtime } from "../shared/types.js";
import { cliSpec, type CliCommandSpec, type CliOptionSpec } from "../shared/cli-spec.js";

const color = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
  blue: "\u001b[34m",
  magenta: "\u001b[35m",
  gray: "\u001b[90m",
  bold: "\u001b[1m",
  reset: "\u001b[0m",
};

export const style = {
  brand: (value: string) => `${color.bold}${color.magenta}${value}${color.reset}`,
  heading: (value: string) => `${color.bold}${color.cyan}${value}${color.reset}`,
  label: (value: string) => `${color.bold}${value}${color.reset}`,
  hint: (value: string) => `${color.gray}${value}${color.reset}`,
  command: (value: string) => `${color.blue}${value}${color.reset}`,
  pass: (value: string) => `${color.green}✓ ${value}${color.reset}`,
  warn: (value: string) => `${color.yellow}! ${value}${color.reset}`,
  fail: (value: string) => `${color.red}✗ ${value}${color.reset}`,
};

export type PrintHealthOptions = {
  verbose?: boolean;
  /** Controls the rerun hint when issues are hidden. Omit to suppress the hint. */
  verboseHint?: "self" | "doctor" | "check";
};

export function section(runtime: Runtime, title: string): void {
  runtime.out.log("");
  runtime.out.log(`${style.heading(title)}:`);
}

export function printBanner(runtime: Runtime): void {
  runtime.out.log(`${style.brand("Fentaris")} ${style.hint("MCP proxy toolkit")}`);
}

export function printHealthResults(runtime: Runtime, results: HealthResult[], options: PrintHealthOptions = {}): void {
  const verbose = options.verbose === true;
  const passes = results.filter((result) => result.status === "pass");
  const warnings = results.filter((result) => result.status === "warn");
  const failures = results.filter((result) => result.status === "fail");
  const issues = results.filter((result) => result.status !== "pass");

  runtime.out.log(`  ${healthSummary(passes.length, warnings.length, failures.length)}`);

  if (issues.length > 0) {
    runtime.out.log("");
    runtime.out.log(`  ${style.label("Issues")}`);
    printHealthResultGroup(runtime, issues, "    ");
  }

  if (verbose && passes.length > 0) {
    runtime.out.log("");
    runtime.out.log(`  ${style.label("Passed")}`);
    printHealthResultGroup(runtime, passes, "    ");
  } else if (!verbose && passes.length > 0 && issues.length > 0 && options.verboseHint) {
    runtime.out.log("");
    runtime.out.log(`  ${style.hint(verboseRerunHint(options.verboseHint))}`);
  }
}

export function nextSteps(steps: string[]): string {
  return ["Next steps:", ...steps.map((step, index) => `  ${index + 1}. ${style.command(step)}`)].join("\n");
}

export function printRootHelp(runtime: Runtime): void {
  printCommandHelp(runtime, []);
}

export function printCommandHelp(runtime: Runtime, path: string[]): void {
  const spec = findCommandSpec(path);
  runtime.out.log(spec.description);
  runtime.out.log("");
  for (const detail of spec.details ?? []) {
    runtime.out.log(detail);
  }
  if (spec.details?.length) {
    runtime.out.log("");
  }
  runtime.out.log(`Usage: ${style.command(spec.usage)}`);
  printCommandGroups(runtime, spec);
  printArguments(runtime, spec);
  printOptions(runtime, spec.options ?? []);
  printEnvironment(runtime, spec);
}

export function printHelp(runtime: Runtime): void {
  printRootHelp(runtime);
}

export function printParseError(runtime: Runtime, message: string, path: string[]): void {
  const spec = findCommandSpec(path);
  runtime.out.error(`error: ${message}`);
  runtime.out.error("");
  runtime.out.error(`Usage: ${spec.usage}`);
  runtime.out.error("");
  runtime.out.error("For more information, try '--help'.");
}

export function printRuntimeError(runtime: Runtime, error: unknown): void {
  runtime.out.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
}

function printCommandGroups(runtime: Runtime, spec: CliCommandSpec): void {
  for (const group of spec.commandGroups ?? []) {
    runtime.out.log("");
    runtime.out.log(`${group.title}:`);
    for (const command of group.commands) {
      runtime.out.log(`  ${command.name.padEnd(12)} ${command.summary}`);
    }
  }
}

function printArguments(runtime: Runtime, spec: CliCommandSpec): void {
  if (!spec.arguments?.length) {
    return;
  }

  runtime.out.log("");
  runtime.out.log("Arguments:");
  for (const argument of spec.arguments) {
    const name = argument.required === true ? `<${argument.name}>` : `[${argument.name}]`;
    runtime.out.log(`  ${name.padEnd(18)} ${argument.description}`);
  }
}

function printOptions(runtime: Runtime, options: CliOptionSpec[]): void {
  if (options.length === 0) {
    return;
  }

  runtime.out.log("");
  runtime.out.log("Options:");
  for (const option of options) {
    const names = formatOptionNames(option);
    runtime.out.log(`  ${names.padEnd(28)} ${option.description}`);
  }
}

function printEnvironment(runtime: Runtime, spec: CliCommandSpec): void {
  if (!spec.environment?.length) {
    return;
  }

  runtime.out.log("");
  runtime.out.log("Environment variables:");
  for (const variable of spec.environment) {
    runtime.out.log(`  ${variable.name.padEnd(22)} ${variable.description}`);
  }
}

function formatOptionNames(option: CliOptionSpec): string {
  const value = option.valueName ? ` <${option.valueName}>` : "";
  const long = `--${option.name}${value}`;
  if (!option.short) {
    return long;
  }
  return `-${option.short}, ${long}`;
}

function findCommandSpec(path: string[]): CliCommandSpec {
  let spec = cliSpec;
  for (const segment of path) {
    const next = spec.commands?.[segment];
    if (!next) {
      return spec;
    }
    spec = next;
  }
  return spec;
}

function printHealthResultGroup(runtime: Runtime, results: HealthResult[], indent: string): void {
  const groups = Array.from(new Set(results.map((result) => result.group)));
  for (const groupName of groups) {
    if (groups.length > 1) {
      runtime.out.log(`${indent}${style.label(groupName)}`);
    }
    const lineIndent = groups.length > 1 ? `${indent}  ` : indent;
    for (const result of results.filter((item) => item.group === groupName)) {
      printHealthResultLine(runtime, result, lineIndent);
    }
  }
}

function printHealthResultLine(runtime: Runtime, result: HealthResult, indent: string): void {
  runtime.out.log(`${indent}${marker(result.status)} ${result.label} ${style.hint(result.detail)}`);
  if (result.hint) {
    runtime.out.log(`${indent}  ${style.hint(`→ ${result.hint}`)}`);
  }
}

function marker(status: HealthStatus): string {
  if (status === "pass") {
    return `${color.green}✓${color.reset}`;
  }
  if (status === "warn") {
    return `${color.yellow}!${color.reset}`;
  }
  return `${color.red}✗${color.reset}`;
}

function healthSummary(pass: number, warn: number, fail: number): string {
  if (fail === 0 && warn === 0) {
    return style.pass(`All checks passed (${pass})`);
  }

  const parts: string[] = [];
  if (fail > 0) {
    parts.push(style.fail(`${fail} failed`));
  }
  if (warn > 0) {
    parts.push(style.warn(`${warn} warning${warn === 1 ? "" : "s"}`));
  }
  parts.push(style.hint(`${pass} passed`));
  return parts.join(", ");
}

function verboseRerunHint(hint: NonNullable<PrintHealthOptions["verboseHint"]>): string {
  if (hint === "self") {
    return "Re-run with --verbose to list passed checks.";
  }
  if (hint === "doctor") {
    return "Run fentaris doctor --verbose to list passed checks.";
  }
  return "Run fentaris check --verbose to list passed checks.";
}

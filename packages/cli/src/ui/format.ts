import type { HealthResult, HealthStatus, Runtime } from "../shared/types.js";
import { cliSpec, type CliCommandSpec, type CliOptionSpec } from "../shared/cli-spec.js";

const color = {
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  cyan: "\u001b[36m",
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
  command: (value: string) => `${color.green}${value}${color.reset}`,
  option: (value: string) => `${color.yellow}${value}${color.reset}`,
  argument: (value: string) => `${color.yellow}${value}${color.reset}`,
  error: (value: string) => `${color.red}${value}${color.reset}`,
  pass: (value: string) => `${color.green}✓ ${value}${color.reset}`,
  warn: (value: string) => `${color.yellow}! ${value}${color.reset}`,
  fail: (value: string) => `${color.red}✗ ${value}${color.reset}`,
};

export function section(runtime: Runtime, title: string): void {
  runtime.out.log("");
  runtime.out.log(`${style.heading(title)}:`);
}

export function printBanner(runtime: Runtime): void {
  runtime.out.log(`${style.brand("Fentaris")} ${style.hint("MCP proxy toolkit")}`);
}

export function printHealthResults(runtime: Runtime, results: HealthResult[]): void {
  const groups = Array.from(new Set(results.map((result) => result.group)));
  for (const groupName of groups) {
    runtime.out.log(`  ${style.label(groupName)}`);
    for (const result of results.filter((item) => item.group === groupName)) {
      runtime.out.log(`    ${marker(result.status)} ${result.label} ${style.hint(result.detail)}`);
      if (result.hint) {
        runtime.out.log(`      ${style.hint(result.hint)}`);
      }
    }
  }

  const failCount = results.filter((result) => result.status === "fail").length;
  const warnCount = results.filter((result) => result.status === "warn").length;
  runtime.out.log(`  ${summary(results.length - failCount - warnCount, warnCount, failCount)}`);
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
  runtime.out.log(`Usage: ${spec.usage}`);
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
  runtime.out.error(`error: ${message} ${style.error("✗")}`);
  runtime.out.error("");
  runtime.out.error(`Usage: ${spec.usage}`);
  runtime.out.error("");
  runtime.out.error("For more information, try '--help'.");
}

export function printRuntimeError(runtime: Runtime, error: unknown): void {
  runtime.out.error(`Error: ${error instanceof Error ? error.message : String(error)} ${style.error("✗")}`);
}

function printCommandGroups(runtime: Runtime, spec: CliCommandSpec): void {
  for (const group of spec.commandGroups ?? []) {
    runtime.out.log("");
    runtime.out.log(`${group.title}:`);
    for (const command of group.commands) {
      runtime.out.log(`  ${style.command(command.name.padEnd(12))} ${style.hint(command.summary)}`);
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
    runtime.out.log(`  ${style.argument(name.padEnd(18))} ${style.hint(argument.description)}`);
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
    runtime.out.log(`  ${style.option(names.padEnd(28))} ${style.hint(option.description)}`);
  }
}

function printEnvironment(runtime: Runtime, spec: CliCommandSpec): void {
  if (!spec.environment?.length) {
    return;
  }

  runtime.out.log("");
  runtime.out.log("Environment variables:");
  for (const variable of spec.environment) {
    runtime.out.log(`  ${style.option(variable.name.padEnd(22))} ${style.hint(variable.description)}`);
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

function marker(status: HealthStatus): string {
  if (status === "pass") {
    return style.pass("");
  }
  if (status === "warn") {
    return style.warn("");
  }
  return style.fail("");
}

function summary(pass: number, warn: number, fail: number): string {
  const parts = [style.pass(`${pass} pass`)];
  if (warn > 0) {
    parts.push(style.warn(`${warn} warn`));
  }
  if (fail > 0) {
    parts.push(style.fail(`${fail} fail`));
  }
  return `Summary ${parts.join("  ")}`;
}

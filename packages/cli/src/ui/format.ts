import type { HealthResult, HealthStatus, Runtime } from "../shared/types.js";

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

export function section(runtime: Runtime, title: string): void {
  runtime.out.log("");
  runtime.out.log(`${style.brand("◆")} ${style.heading(title)}`);
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

export function printHelp(runtime: Runtime): void {
  printBanner(runtime);
  runtime.out.log(`Usage:
  ${style.command("fentaris init [project-name] [--skip-install]")}
  ${style.command("fentaris dev")}
  ${style.command("fentaris check [--offline] [--strict]")}
  ${style.command("fentaris doctor [--fix] [--strict] [--json] [--runtime] [--timeout <ms>]")}
  ${style.command("fentaris build")}
  ${style.command("fentaris secrets set <reference> [--user <id> | --group <id>]")}
  ${style.command("fentaris secrets list [--json]")}
  ${style.command("fentaris secrets unset <reference> [--user <id> | --group <id>]")}
  ${style.command("fentaris secrets manifest [--check]")}
  ${style.command("fentaris secrets doctor [--strict] [--json]")}

Legacy local auth:
  ${style.command("fentaris auth init --dir .fentaris/auth --key <key>")}
  ${style.command("fentaris auth set-api-key --dir .fentaris/auth --key <key> --user <id> --api-key <secret>")}
  ${style.command("fentaris auth set-credential --dir .fentaris/auth --key <key> --ref <name> --value <secret> [--user <id> | --group <id>]")}
  ${style.command("fentaris auth inspect --dir .fentaris/auth --key <key>")}`);
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

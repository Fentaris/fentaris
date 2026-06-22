import type { CliOptions, Runtime } from "../../shared/types.js";

export async function authKeyFromRuntime(runtime: Runtime, options: CliOptions): Promise<string> {
  if (typeof options.key === "string") {
    runtime.out.error("Warning: --key exposes the local encryption key in process arguments. Prefer FENTARIS_AUTH_KEY for automation.");
    return options.key;
  }
  if (typeof runtime.env.FENTARIS_AUTH_KEY === "string" && runtime.env.FENTARIS_AUTH_KEY.trim()) {
    return runtime.env.FENTARIS_AUTH_KEY;
  }
  return runtime.prompt.text("Local auth encryption key", { secret: true });
}

export function secretScope(options: CliOptions): string {
  if (typeof options.user === "string") {
    return `user ${options.user}`;
  }
  if (typeof options.group === "string") {
    return `group ${options.group}`;
  }
  return "default";
}

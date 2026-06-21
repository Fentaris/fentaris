import type { SpawnOptions } from "node:child_process";

export type CliOptions = Record<string, string | boolean>;

export type CliCommand = {
  name: string;
  args: string[];
  options: CliOptions;
};

export type ParseResult =
  | { kind: "ok"; command: CliCommand; path: string[] }
  | { kind: "help"; path: string[] }
  | { kind: "version" }
  | { kind: "parse-error"; message: string; path: string[] };

export type PackageManager = "pnpm" | "npm" | "bun";

export type CommandResult = { code: number };

export type ProcessRunner = (command: string, args: string[], options?: SpawnOptions) => Promise<CommandResult>;

export type ExecProbe = (command: string, args?: string[]) => boolean;

export type Prompt = {
  text(question: string, options?: { secret?: boolean; defaultValue?: string }): Promise<string>;
  select<T extends string>(question: string, choices: T[]): Promise<T>;
  confirm(question: string): Promise<boolean>;
  close(): void;
};

export type Runtime = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  out: Pick<typeof console, "log" | "error">;
  runner: ProcessRunner;
  probe: ExecProbe;
  prompt: Prompt;
};

export type TemplateInput = {
  projectName: string;
  packageManager: PackageManager;
  port: number;
  proxyPath: string;
};

export type HealthStatus = "pass" | "warn" | "fail";

export type HealthResult = {
  group: string;
  label: string;
  status: HealthStatus;
  detail: string;
  hint?: string;
  metadata?: Record<string, unknown>;
  fix?: () => Promise<void>;
};

export type ProjectConfig = {
  name: string;
  packageManager: PackageManager;
  entrypoint: string;
  port: number;
  host?: string;
  path: string;
  authDir: string;
  secrets?: {
    provider?: "local";
  };
  panther?: {
    projectId?: string;
    environment?: string;
  };
};

export type ProjectDiscovery = { root: string; configPath: string; config: ProjectConfig };

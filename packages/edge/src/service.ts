import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);

export type EdgeServiceOperation = "install" | "start" | "stop" | "restart" | "uninstall";

export interface EdgeServiceDefinition {
  readonly executable: string;
  readonly args?: readonly string[];
  readonly environment?: Readonly<Record<string, string>>;
  readonly workingDirectory?: string;
}

export interface EdgeServiceResult {
  readonly operation: EdgeServiceOperation;
  readonly persistent: boolean;
  readonly adapter: "launchd" | "systemd-user" | "windows-user-task" | "foreground";
  readonly nextActions: readonly string[];
}

export interface EdgeServiceAdapter {
  readonly supported: boolean;
  install(definition: EdgeServiceDefinition): Promise<EdgeServiceResult>;
  start(): Promise<EdgeServiceResult>;
  stop(): Promise<EdgeServiceResult>;
  restart(): Promise<EdgeServiceResult>;
  uninstall(): Promise<EdgeServiceResult>;
}

export interface EdgeServiceCommandRunner {
  run(command: string, args: readonly string[]): Promise<void>;
}

export interface EdgeServiceFiles {
  write(file: string, contents: string): Promise<void>;
  delete(file: string): Promise<void>;
}

export class NodeEdgeServiceCommandRunner implements EdgeServiceCommandRunner {
  async run(command: string, args: readonly string[]): Promise<void> {
    await execFileAsync(command, [...args], { windowsHide: true });
  }
}

export class NodeEdgeServiceFiles implements EdgeServiceFiles {
  async write(file: string, contents: string): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, contents, { encoding: "utf8", mode: 0o600 });
  }
  async delete(file: string): Promise<void> {
    await rm(file, { force: true });
  }
}

/** macOS per-user launchd adapter. */
export class LaunchdEdgeServiceAdapter implements EdgeServiceAdapter {
  readonly supported = true;
  constructor(
    private readonly plistFile: string,
    private readonly runner: EdgeServiceCommandRunner = new NodeEdgeServiceCommandRunner(),
    private readonly files: EdgeServiceFiles = new NodeEdgeServiceFiles(),
    private readonly uid: number = process.getuid?.() ?? 0,
    private readonly label = "dev.fentaris.edge",
  ) {}

  async install(definition: EdgeServiceDefinition): Promise<EdgeServiceResult> {
    await this.files.write(this.plistFile, launchdPlist(this.label, definition));
    await this.runner.run("launchctl", ["bootstrap", `gui/${this.uid}`, this.plistFile]);
    return result("install", "launchd", true);
  }
  async start() { await this.runner.run("launchctl", ["kickstart", `gui/${this.uid}/${this.label}`]); return result("start", "launchd", true); }
  async stop() { await this.runner.run("launchctl", ["kill", "SIGTERM", `gui/${this.uid}/${this.label}`]); return result("stop", "launchd", true); }
  async restart() { await this.stop(); await this.start(); return result("restart", "launchd", true); }
  async uninstall() {
    await this.runner.run("launchctl", ["bootout", `gui/${this.uid}`, this.plistFile]);
    await this.files.delete(this.plistFile);
    return result("uninstall", "launchd", true);
  }
}

/** Linux systemd user-service adapter. */
export class SystemdUserEdgeServiceAdapter implements EdgeServiceAdapter {
  readonly supported = true;
  constructor(
    private readonly unitFile: string,
    private readonly runner: EdgeServiceCommandRunner = new NodeEdgeServiceCommandRunner(),
    private readonly files: EdgeServiceFiles = new NodeEdgeServiceFiles(),
    private readonly unitName = "fentaris-edge.service",
  ) {}

  async install(definition: EdgeServiceDefinition): Promise<EdgeServiceResult> {
    await this.files.write(this.unitFile, systemdUnit(definition));
    await this.runner.run("systemctl", ["--user", "daemon-reload"]);
    await this.runner.run("systemctl", ["--user", "enable", "--now", this.unitName]);
    return result("install", "systemd-user", true);
  }
  async start() { await this.runner.run("systemctl", ["--user", "start", this.unitName]); return result("start", "systemd-user", true); }
  async stop() { await this.runner.run("systemctl", ["--user", "stop", this.unitName]); return result("stop", "systemd-user", true); }
  async restart() { await this.runner.run("systemctl", ["--user", "restart", this.unitName]); return result("restart", "systemd-user", true); }
  async uninstall() {
    await this.runner.run("systemctl", ["--user", "disable", "--now", this.unitName]);
    await this.files.delete(this.unitFile);
    await this.runner.run("systemctl", ["--user", "daemon-reload"]);
    return result("uninstall", "systemd-user", true);
  }
}

/** Windows per-user scheduled-task adapter. */
export class WindowsUserEdgeServiceAdapter implements EdgeServiceAdapter {
  readonly supported = true;
  constructor(
    private readonly runner: EdgeServiceCommandRunner = new NodeEdgeServiceCommandRunner(),
    private readonly taskName = "Fentaris Edge",
  ) {}

  async install(definition: EdgeServiceDefinition): Promise<EdgeServiceResult> {
    const command = windowsCommandLine(definition.executable, definition.args ?? []);
    await this.runner.run("schtasks.exe", ["/Create", "/TN", this.taskName, "/TR", command, "/SC", "ONLOGON", "/F"]);
    await this.start();
    return result("install", "windows-user-task", true);
  }
  async start() { await this.runner.run("schtasks.exe", ["/Run", "/TN", this.taskName]); return result("start", "windows-user-task", true); }
  async stop() { await this.runner.run("schtasks.exe", ["/End", "/TN", this.taskName]); return result("stop", "windows-user-task", true); }
  async restart() { await this.stop(); await this.start(); return result("restart", "windows-user-task", true); }
  async uninstall() { await this.stop(); await this.runner.run("schtasks.exe", ["/Delete", "/TN", this.taskName, "/F"]); return result("uninstall", "windows-user-task", true); }
}

/** Explicit foreground fallback retaining enrollment identity. */
export class ForegroundEdgeServiceAdapter implements EdgeServiceAdapter {
  readonly supported = false;
  constructor(private readonly command: string) {}
  async install() { return this.fallback("install"); }
  async start() { return this.fallback("start"); }
  async stop() { return this.fallback("stop"); }
  async restart() { return this.fallback("restart"); }
  async uninstall() { return result("uninstall", "foreground", false); }
  private fallback(operation: EdgeServiceOperation) {
    return Promise.resolve(result(operation, "foreground", false, [`Run ${this.command} to keep Edge online.`]));
  }
}

export function edgeServiceAdapter(input: {
  readonly platform?: NodeJS.Platform;
  readonly serviceFile: string;
  readonly foregroundCommand: string;
  readonly runner?: EdgeServiceCommandRunner;
  readonly files?: EdgeServiceFiles;
}): EdgeServiceAdapter {
  const platform = input.platform ?? process.platform;
  if (platform === "darwin") return new LaunchdEdgeServiceAdapter(input.serviceFile, input.runner, input.files);
  if (platform === "linux") return new SystemdUserEdgeServiceAdapter(input.serviceFile, input.runner, input.files);
  if (platform === "win32") return new WindowsUserEdgeServiceAdapter(input.runner);
  return new ForegroundEdgeServiceAdapter(input.foregroundCommand);
}

function result(
  operation: EdgeServiceOperation,
  adapter: EdgeServiceResult["adapter"],
  persistent: boolean,
  nextActions: readonly string[] = [],
): EdgeServiceResult {
  return Object.freeze({ operation, adapter, persistent, nextActions: Object.freeze([...nextActions]) });
}

function launchdPlist(label: string, definition: EdgeServiceDefinition): string {
  const args = [definition.executable, ...(definition.args ?? [])].map((value) => `<string>${xml(value)}</string>`).join("");
  const environment = Object.entries(definition.environment ?? {})
    .map(([key, value]) => `<key>${xml(key)}</key><string>${xml(value)}</string>`)
    .join("");
  return `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${xml(label)}</string><key>ProgramArguments</key><array>${args}</array>${environment ? `<key>EnvironmentVariables</key><dict>${environment}</dict>` : ""}${definition.workingDirectory ? `<key>WorkingDirectory</key><string>${xml(definition.workingDirectory)}</string>` : ""}<key>RunAtLoad</key><true/><key>KeepAlive</key><true/></dict></plist>`;
}

function systemdUnit(definition: EdgeServiceDefinition): string {
  const command = [definition.executable, ...(definition.args ?? [])].map(systemdQuote).join(" ");
  const environment = Object.entries(definition.environment ?? {})
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}\n`)
    .join("");
  return `[Unit]\nDescription=Fentaris Edge Agent\nAfter=network-online.target\n\n[Service]\nExecStart=${command}\nRestart=on-failure\nRestartSec=5\n${definition.workingDirectory ? `WorkingDirectory=${definition.workingDirectory}\n` : ""}${environment}\n[Install]\nWantedBy=default.target\n`;
}

function windowsCommandLine(executable: string, args: readonly string[]): string {
  return [executable, ...args].map((value) => `"${value.replaceAll('"', '\\"')}"`).join(" ");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

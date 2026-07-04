import { spawn, type ChildProcess } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export interface EdgePaths {
  readonly dataDir: string;
  readonly configFile: string;
  readonly deviceKeyFile: string;
  readonly credentialFile: string;
}

export interface JsonStore<T> {
  load(): Promise<T | undefined>;
  save(value: T): Promise<void>;
  delete(): Promise<void>;
}

export interface CredentialStore {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
}

export interface ProcessStartOptions {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
  readonly stderr?: "inherit" | "pipe" | "ignore";
}

export interface SupervisedProcess {
  readonly pid?: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  terminate(signal?: NodeJS.Signals): void;
}

export interface ProcessSupervisorAdapter {
  start(options: ProcessStartOptions): Promise<SupervisedProcess>;
}

export interface EdgePlatform {
  readonly paths: EdgePaths;
  readonly deviceKeyStore: JsonStore<StoredDeviceKeyPair>;
  readonly configStore: JsonStore<EdgeLocalConfig>;
  readonly credentialStore: CredentialStore;
  readonly processSupervisor: ProcessSupervisorAdapter;
}

export interface StoredDeviceKeyPair {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly createdAt: number;
}

export interface EdgeLocalConfig {
  readonly edgeNodeId: string;
  readonly tenantId: string;
  readonly gatewayUrl: string;
  readonly enrolledAt: number;
  readonly hostnameLabel?: string;
}

/** Resolve platform-specific local state paths without using them as identity. */
export function defaultEdgePaths(home: string = homedir(), platform: NodeJS.Platform = process.platform): EdgePaths {
  const dataDir = platform === "win32"
    ? path.join(process.env.LOCALAPPDATA ?? home, "Fentaris", "edge")
    : platform === "darwin"
      ? path.join(home, "Library", "Application Support", "Fentaris", "edge")
      : path.join(process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state"), "fentaris", "edge");
  return {
    dataDir,
    configFile: path.join(dataDir, "config.json"),
    deviceKeyFile: path.join(dataDir, "device-key.json"),
    credentialFile: path.join(dataDir, "credentials.json"),
  };
}

/** Protected JSON file store used for local config and fallback secret state. */
export class ProtectedJsonStore<T> implements JsonStore<T> {
  constructor(
    private readonly file: string,
    private readonly mode: number = 0o600,
  ) {}

  async load(): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(this.file, "utf8")) as T;
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async save(value: T): Promise<void> {
    const directory = path.dirname(this.file);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", mode: this.mode });
    await chmod(temporary, this.mode).catch(() => undefined);
    await rename(temporary, this.file);
    await chmod(this.file, this.mode).catch(() => undefined);
  }

  async delete(): Promise<void> {
    await rm(this.file, { force: true });
  }
}

/**
 * Protected file credential fallback. Platforms with an OS credential manager
 * should supply another {@link CredentialStore}; this adapter never exposes
 * the backing path or stored values through status APIs.
 */
export class ProtectedFileCredentialStore implements CredentialStore {
  private readonly store: ProtectedJsonStore<Record<string, string>>;
  constructor(file: string) {
    this.store = new ProtectedJsonStore(file);
  }
  async get(name: string) {
    return (await this.store.load())?.[name];
  }
  async set(name: string, value: string) {
    const credentials = await this.store.load() ?? {};
    await this.store.save({ ...credentials, [name]: value });
  }
  async delete(name: string) {
    const credentials = await this.store.load() ?? {};
    delete credentials[name];
    if (Object.keys(credentials).length === 0) await this.store.delete();
    else await this.store.save(credentials);
  }
}

/** Node child-process implementation hidden behind the process supervisor seam. */
export class NodeProcessSupervisor implements ProcessSupervisorAdapter {
  async start(options: ProcessStartOptions): Promise<SupervisedProcess> {
    const child = spawn(options.command, [...(options.args ?? [])], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", options.stderr ?? "pipe"],
      windowsHide: true,
    });
    return childHandle(child);
  }
}

export function nodeEdgePlatform(paths: EdgePaths = defaultEdgePaths()): EdgePlatform {
  return {
    paths,
    deviceKeyStore: new ProtectedJsonStore(paths.deviceKeyFile),
    configStore: new ProtectedJsonStore(paths.configFile),
    credentialStore: new ProtectedFileCredentialStore(paths.credentialFile),
    processSupervisor: new NodeProcessSupervisor(),
  };
}

function childHandle(child: ChildProcess): SupervisedProcess {
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  return {
    pid: child.pid,
    exited,
    terminate: (signal = "SIGTERM") => child.kill(signal),
  };
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}


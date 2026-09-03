import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { edgeError } from "@fentaris/core";
import {
  EdgeLocalControlServer,
  EdgePersistentAgent,
  FileEdgeSingletonLock,
  ForegroundEdgeServiceAdapter,
  LaunchdEdgeServiceAdapter,
  SystemdUserEdgeServiceAdapter,
  WindowsUserEdgeServiceAdapter,
  callEdgeLocalControl,
  edgeLocalControlAddress,
  reconnectDelay,
  type EdgeAgent,
  type EdgeAgentStatus,
  type EdgePersistentStatus,
  type EdgeServiceCommandRunner,
  type EdgeServiceFiles,
  type JsonStore,
} from "../src/index.js";

class MemoryStore<T> implements JsonStore<T> {
  value?: T;
  async load() { return this.value; }
  async save(value: T) { this.value = structuredClone(value); }
  async delete() { this.value = undefined; }
}

class FakeAgent {
  readonly connect = vi.fn(async () => {
    const next = this.connectErrors.shift();
    if (next) throw next;
    this.connected = true;
    this.disconnectPromise = new Promise<void>((resolve) => { this.resolveDisconnect = resolve; });
  });
  readonly disconnect = vi.fn(async () => {
    this.connected = false;
    this.resolveDisconnect?.();
  });
  readonly connectErrors: unknown[] = [];
  connected = false;
  private disconnectPromise: Promise<void> = Promise.resolve();
  private resolveDisconnect?: () => void;
  async waitUntilDisconnected() { await this.disconnectPromise; }
  async status(): Promise<EdgeAgentStatus> {
    return { enrolled: true, connected: this.connected, desiredDeployments: 0, readyDeployments: 0, blockedDeployments: 0 };
  }
}

const waitForState = async (store: MemoryStore<EdgePersistentStatus>, state: EdgePersistentStatus["state"]) => {
  await vi.waitFor(() => expect(store.value?.state).toBe(state));
};

describe("persistent Edge lifecycle", () => {
  it("recovers a singleton lock left by a terminated process", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-stale-lock-"));
    try {
      const lockFile = path.join(directory, "agent.lock");
      await writeFile(lockFile, "99999999:stale-instance", { mode: 0o600 });
      const lease = await new FileEdgeSingletonLock(lockFile).acquire();
      await lease.release();
      await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("enforces a singleton, persists lifecycle state, and cleans workloads on graceful stop", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-lifecycle-"));
    try {
      const lockFile = path.join(directory, "agent.lock");
      const firstLock = new FileEdgeSingletonLock(lockFile);
      const lease = await firstLock.acquire();
      await expect(new FileEdgeSingletonLock(lockFile).acquire()).rejects.toMatchObject({ code: "EDGE_WORKLOAD" });
      await lease.release();

      const fake = new FakeAgent();
      const status = new MemoryStore<EdgePersistentStatus>();
      const persistent = new EdgePersistentAgent({
        agent: fake as unknown as EdgeAgent,
        lock: firstLock,
        statusStore: status,
        random: () => 0.5,
      });
      await persistent.start();
      await waitForState(status, "ready");
      expect((await persistent.status()).agent.connected).toBe(true);
      await persistent.stop();
      expect(status.value?.state).toBe("stopped");
      expect(fake.disconnect).toHaveBeenCalled();
      await expect(stat(lockFile)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses bounded exponential reconnect, resets after an explicit reconnect, and stops on terminal errors", async () => {
    const fake = new FakeAgent();
    fake.connectErrors.push(edgeError("EDGE_UNAVAILABLE", "temporary"));
    const status = new MemoryStore<EdgePersistentStatus>();
    const sleeps: number[] = [];
    const persistent = new EdgePersistentAgent({
      agent: fake as unknown as EdgeAgent,
      lock: { acquire: async () => ({ release: async () => undefined }) },
      statusStore: status,
      reconnect: { initialDelayMs: 10, maxDelayMs: 40, multiplier: 2, jitterRatio: 0, stableConnectionMs: 100 },
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5,
    });
    await persistent.start();
    await waitForState(status, "ready");
    expect(sleeps).toEqual([10]);
    await persistent.reconnectNow();
    await vi.waitFor(() => expect(fake.connect).toHaveBeenCalledTimes(3));
    expect(sleeps).toContain(0);
    await persistent.stop();
    expect(reconnectDelay(10, { initialDelayMs: 10, maxDelayMs: 40, multiplier: 2, jitterRatio: 0, stableConnectionMs: 100, terminalRetryMs: 0 })).toBe(40);

    const terminalFake = new FakeAgent();
    terminalFake.connectErrors.push(edgeError("EDGE_PROTOCOL", "unsupported"));
    const terminalStatus = new MemoryStore<EdgePersistentStatus>();
    const terminal = new EdgePersistentAgent({
      agent: terminalFake as unknown as EdgeAgent,
      lock: { acquire: async () => ({ release: async () => undefined }) },
      statusStore: terminalStatus,
    });
    await terminal.start();
    await terminal.wait();
    expect(terminalStatus.value?.state).toBe("terminal");
    expect(terminalFake.connect).toHaveBeenCalledOnce();
  });
});

describe("owner-protected local control channel", () => {
  it("authorizes only the fixed command set over an owner-only Unix socket", async () => {
    if (process.platform === "win32") return;
    const directory = await mkdtemp(path.join(tmpdir(), "fentaris-edge-control-"));
    const address = edgeLocalControlAddress(directory, "linux");
    const calls: string[] = [];
    const agent = {
      status: async () => ({ state: "ready", agent: { connected: true } }),
      reconnectNow: async () => { calls.push("reconnect"); },
      stop: async () => { calls.push("stop"); },
    };
    const server = new EdgeLocalControlServer({
      endpoint: { address, credential: "credential-123" },
      agent: agent as unknown as EdgePersistentAgent,
      onSetupHandoff: async () => ({ status: "pending" }),
    });
    try {
      await server.start();
      expect((await stat(address)).mode & 0o777).toBe(0o600);
      await expect(callEdgeLocalControl({ address, credential: "credential-123" }, "status"))
        .resolves.toMatchObject({ ok: true, data: { state: "ready" } });
      await expect(callEdgeLocalControl({ address, credential: "wrong" }, "status"))
        .resolves.toMatchObject({ ok: false, error: { code: "EDGE_UNAUTHORIZED_TARGET" } });
      await callEdgeLocalControl({ address, credential: "credential-123" }, "reconnect");
      await callEdgeLocalControl({ address, credential: "credential-123" }, "setup-handoff");
      expect(calls).toEqual(["reconnect"]);
      await server.stop();
      await expect(server.stop()).resolves.toBeUndefined();
    } finally {
      await server.stop();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses Windows named-pipe addresses", () => {
    expect(edgeLocalControlAddress("C:\\Users\\Alice\\Fentaris", "win32")).toMatch(/^\\\\\.\\pipe\\fentaris-edge-/);
  });

  it("keeps Unix socket addresses bounded for deeply nested state and temporary directories", () => {
    const directory = path.join(tmpdir(), "nested-state-".repeat(20));
    const originalTemporaryDirectory = process.env.TMPDIR;
    process.env.TMPDIR = path.join("/private/tmp", "nested-temporary-directory-".repeat(20));
    try {
      const address = edgeLocalControlAddress(directory, "darwin");
      expect(address.length).toBeLessThan(100);
      expect(address).toBe(edgeLocalControlAddress(directory, "darwin"));
      expect(address).not.toContain("nested-state");
      expect(address).toMatch(/^\/tmp\/fe-[a-f0-9]{20}\.sock$/);
    } finally {
      if (originalTemporaryDirectory === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTemporaryDirectory;
    }
  });
});

describe("platform service adapters", () => {
  const fixture = () => {
    const commands: Array<[string, readonly string[]]> = [];
    const writes: Array<[string, string]> = [];
    const runner: EdgeServiceCommandRunner = { run: async (command, args) => { commands.push([command, args]); } };
    const files: EdgeServiceFiles = {
      write: async (file, contents) => { writes.push([file, contents]); },
      delete: async () => undefined,
    };
    return { commands, writes, runner, files };
  };
  const definition = {
    executable: "/usr/bin/node",
    args: ["edge.js", "run"],
    environment: { FENTARIS_EDGE_STATE_DIR: "/tmp/edge & isolated" },
    workingDirectory: "/tmp/edge <work>",
  } as const;

  it("installs and controls launchd and systemd-user definitions", async () => {
    const launchd = fixture();
    const launchdAdapter = new LaunchdEdgeServiceAdapter("/tmp/edge.plist", launchd.runner, launchd.files, 501);
    await launchdAdapter.install(definition);
    await launchdAdapter.restart();
    await launchdAdapter.uninstall();
    expect(launchd.writes[0]?.[1]).toContain("RunAtLoad");
    expect(launchd.writes[0]?.[1]).toContain("<key>FENTARIS_EDGE_STATE_DIR</key><string>/tmp/edge &amp; isolated</string>");
    expect(launchd.writes[0]?.[1]).toContain("<key>WorkingDirectory</key><string>/tmp/edge &lt;work&gt;</string>");
    expect(launchd.commands).toContainEqual(["launchctl", ["bootstrap", "gui/501", "/tmp/edge.plist"]]);

    const systemd = fixture();
    const systemdAdapter = new SystemdUserEdgeServiceAdapter("/tmp/fentaris-edge.service", systemd.runner, systemd.files);
    await systemdAdapter.install(definition);
    await systemdAdapter.restart();
    await systemdAdapter.uninstall();
    expect(systemd.writes[0]?.[1]).toContain("Restart=on-failure");
    expect(systemd.writes[0]?.[1]).toContain('Environment="FENTARIS_EDGE_STATE_DIR=/tmp/edge & isolated"');
    expect(systemd.writes[0]?.[1]).toContain("WorkingDirectory=/tmp/edge <work>");
    expect(systemd.commands).toContainEqual(["systemctl", ["--user", "enable", "--now", "fentaris-edge.service"]]);
  });

  it("controls a Windows per-user task and provides an actionable foreground fallback", async () => {
    const windows = fixture();
    const adapter = new WindowsUserEdgeServiceAdapter(windows.runner);
    await adapter.install({ executable: "C:\\Program Files\\node.exe", args: ["edge.js", "run"] });
    await adapter.restart();
    await adapter.uninstall();
    expect(windows.commands[0]?.[0]).toBe("schtasks.exe");
    expect(windows.commands[0]?.[1].slice(0, 3)).toEqual(["/Create", "/TN", "Fentaris Edge"]);

    const fallback = new ForegroundEdgeServiceAdapter("fentaris edge run");
    await expect(fallback.install(definition)).resolves.toEqual({
      operation: "install",
      adapter: "foreground",
      persistent: false,
      nextActions: ["Run fentaris edge run to keep Edge online."],
    });
  });
});

import { describe, expect, it, vi } from "vitest";
import { main, parseCommand, runEdge, type EdgeOperatorBackend, type Runtime } from "../src/index.js";

const success = (data: unknown, nextCursor?: string) => ({
  ok: true as const,
  data,
  pagination: nextCursor ? { nextCursor } : null,
  warnings: [],
  nextActions: [],
});

function backend(): EdgeOperatorBackend & Record<string, ReturnType<typeof vi.fn>> {
  return {
    join: vi.fn(async () => success({ status: "enrolled", device: { name: "Mac Studio" }, service: { persistent: true } })),
    run: vi.fn(async () => success({ status: "stopped" })),
    service: vi.fn(async (operation) => success({ operation, persistent: true })),
    list: vi.fn(async () => success([{ device: { name: "Mac Studio", inventoryVersion: 2 }, status: "online" }], "next-1")),
    get: vi.fn(async (device) => success({ device: { name: device, inventoryVersion: 2 }, status: "online" })),
    status: vi.fn(async (device) => success({ device: device ? { name: device } : undefined, state: "ready" })),
    update: vi.fn(async (device) => success({ device: { name: device, inventoryVersion: 3 } })),
    disconnect: vi.fn(async (device) => success({ device: { name: device }, status: "disconnected" })),
    revoke: vi.fn(async (device) => success({ device: { name: device }, status: "revoked" })),
  } as EdgeOperatorBackend & Record<string, ReturnType<typeof vi.fn>>;
}

function runtime(nonInteractive = false) {
  const output: string[] = [];
  const errors: string[] = [];
  const value: Runtime = {
    cwd: process.cwd(),
    env: {},
    out: { log: (line) => output.push(String(line)), error: (line) => errors.push(String(line)) },
    runner: async () => ({ code: 0 }),
    probe: () => true,
    nonInteractive,
    prompt: {
      text: async () => "",
      select: async (_question, choices) => choices[0]!,
      confirm: async () => true,
      close: () => undefined,
    },
  };
  return { value, output, errors };
}

describe("fentaris edge command parsing and help", () => {
  it("parses repeatable join tags and service selection", () => {
    expect(parseCommand(["edge", "join", "https://control.example", "--name", "Mac", "--tag", "xcode", "--tag", "development", "--no-service", "--json"])).toMatchObject({
      kind: "ok",
      command: {
        name: "edge",
        args: ["join", "https://control.example"],
        options: { name: "Mac", tag: "xcode,development", "no-service": true, json: true },
      },
    });
  });

  it("prints contextual help with purpose, flags, and an example", async () => {
    const io = runtime();
    await expect(main(["edge", "join", "--help"], io.value)).resolves.toBe(0);
    expect(io.output.join("\n")).toContain("Enroll this computer");
    expect(io.output.join("\n")).toContain("--tag <TAG>");
    expect(io.output.join("\n")).toContain("fentaris edge join https://control.example");
  });
});

describe("fentaris edge canonical behavior", () => {
  it("runs join with canonical JSON and repeated metadata", async () => {
    const io = runtime();
    const service = backend();
    const command = parseCommand(["edge", "join", "https://control.example", "--name", "Mac Studio", "--tag", "xcode", "--tag", "development", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(command.command, io.value, service)).resolves.toBe(0);
    expect(service.join).toHaveBeenCalledWith(expect.objectContaining({
      controlPlaneUrl: "https://control.example",
      name: "Mac Studio",
      tags: ["xcode", "development"],
      installService: true,
    }));
    expect(JSON.parse(io.output[0]!)).toEqual(expect.objectContaining({ ok: true, pagination: null, warnings: [], nextActions: [] }));
  });

  it("passes compact pagination and identity options to discovery", async () => {
    const io = runtime();
    const service = backend();
    const command = parseCommand(["edge", "list", "--as", "user:alice", "--compact", "--limit", "1", "--cursor", "cursor-1", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await runEdge(command.command, io.value, service);
    expect(service.list).toHaveBeenCalledWith({
      as: "user:alice",
      compact: true,
      limit: 1,
      cursor: "cursor-1",
      include: undefined,
      exclude: undefined,
    });
    expect(JSON.parse(io.output[0]!).pagination).toEqual({ nextCursor: "next-1" });
  });

  it("requires explicit confirmation and emits a safe retry command", async () => {
    const io = runtime(true);
    const service = backend();
    const command = parseCommand(["edge", "revoke", "Mac Studio", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(command.command, io.value, service)).resolves.toBe(2);
    expect(service.revoke).not.toHaveBeenCalled();
    expect(JSON.parse(io.output[0]!)).toMatchObject({
      ok: false,
      error: { code: "CONFIRMATION_REQUIRED", details: {} },
      warnings: [],
      nextActions: [{ command: "fentaris edge revoke 'Mac Studio' --yes --json" }],
    });
  });

  it("returns stable error envelopes and exit codes", async () => {
    const io = runtime();
    const service = backend();
    service.get.mockResolvedValue({
      ok: false,
      error: { code: "EDGE_UNAUTHORIZED_TARGET", message: "Edge device is unavailable or unauthorized.", details: {} },
      warnings: [],
      nextActions: [],
    });
    const command = parseCommand(["edge", "get", "Private Device", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(command.command, io.value, service)).resolves.toBe(3);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ ok: false, error: { code: "EDGE_UNAUTHORIZED_TARGET" } });
  });

  it("renders concise human output for local status", async () => {
    const io = runtime();
    const service = backend();
    const command = parseCommand(["edge", "status"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await runEdge(command.command, io.value, service);
    expect(io.output).toEqual(["ready"]);
  });

  it("summarizes managed install counts in local status without exposing directories", async () => {
    const io = runtime();
    const service = backend();
    service.status.mockResolvedValue(success({
      state: "ready",
      agent: {
        enrolled: true,
        connected: true,
        desiredDeployments: 2,
        readyDeployments: 1,
        blockedDeployments: 1,
        installedPackages: 1,
        pendingInstalls: 0,
        failedInstalls: 1,
      },
    }));
    const command = parseCommand(["edge", "status"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await runEdge(command.command, io.value, service);
    expect(io.output).toEqual(["ready installs 1 installed, 0 pending, 1 failed"]);

    const jsonIo = runtime();
    const jsonCommand = parseCommand(["edge", "status", "--json"]);
    if (jsonCommand.kind !== "ok") throw new Error("parse failed");
    await runEdge(jsonCommand.command, jsonIo.value, service);
    expect(JSON.parse(jsonIo.output[0]!).data.agent).toMatchObject({ installedPackages: 1, failedInstalls: 1 });
  });
});

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
    installation: vi.fn(async (action, deploymentId) => success({ action, deploymentId, installation: "ready", setup: "ready", workload: "ready", readiness: "ready" })),
    approve: vi.fn(async (userCode, decision) => success({ status: "approved", userCode, ...decision })),
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

  it("documents the protected approval command and stable machine flags", async () => {
    const io = runtime();
    await expect(main(["edge", "approve", "--help"], io.value)).resolves.toBe(0);
    expect(io.output.join("\n")).toContain("protected local operator channel");
    expect(io.output.join("\n")).toContain("--subject <SUBJECT>");
    expect(io.output.join("\n")).toContain("--json");
  });

  it("documents the cross-platform Edge state override", async () => {
    const io = runtime();
    await expect(main(["--help"], io.value)).resolves.toBe(0);
    expect(io.output.join("\n")).toContain("FENTARIS_EDGE_STATE_DIR");
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

  it("emits verification details while join is still pending", async () => {
    const io = runtime();
    const service = backend();
    let finishJoin!: () => void;
    const pending = new Promise<void>((resolve) => { finishJoin = resolve; });
    service.join.mockImplementation(async (input) => {
      input.onVerification?.({ verificationUri: "https://control.example/verify", userCode: "ABCD-EFGH" });
      await pending;
      return success({ status: "enrolled", device: { name: "Mac Studio" } });
    });
    const command = parseCommand(["edge", "join", "https://control.example", "--no-service", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");

    const running = runEdge(command.command, io.value, service);
    await vi.waitFor(() => expect(io.errors).toHaveLength(1));
    expect(io.output).toEqual([]);
    expect(JSON.parse(io.errors[0]!)).toEqual({
      type: "edge.verification_required",
      data: { verificationUri: "https://control.example/verify", userCode: "ABCD-EFGH" },
      nextAction: {
        description: "Approve this Edge device",
        command: "fentaris edge approve 'ABCD-EFGH' --subject <subject>",
      },
    });

    finishJoin();
    await expect(running).resolves.toBe(0);
    expect(JSON.parse(io.output[0]!)).toMatchObject({ ok: true, data: { status: "enrolled" } });
  });

  it("approves an exact code with confirmation and canonical JSON", async () => {
    const io = runtime(true);
    const service = backend();
    const command = parseCommand(["edge", "approve", "ABCD-EFGH", "--subject", "alice", "--tenant", "default", "--actor", "operator", "--yes", "--json"]);
    if (command.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(command.command, io.value, service)).resolves.toBe(0);
    expect(service.approve).toHaveBeenCalledWith("ABCD-EFGH", expect.objectContaining({
      tenantId: "default",
      subjectId: "alice",
      actorId: "operator",
      approvedAt: expect.any(Number),
    }));
    expect(JSON.parse(io.output[0]!)).toMatchObject({ ok: true, pagination: null, warnings: [], nextActions: [] });
  });

  it("refuses unconfirmed or subject-less approval", async () => {
    const service = backend();
    const missingIo = runtime(true);
    const missing = parseCommand(["edge", "approve", "ABCD-EFGH", "--json"]);
    if (missing.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(missing.command, missingIo.value, service)).resolves.toBe(2);
    expect(JSON.parse(missingIo.output[0]!)).toMatchObject({ ok: false, error: { code: "EDGE_CLI_USAGE" } });

    const unconfirmedIo = runtime(true);
    const unconfirmed = parseCommand(["edge", "approve", "ABCD-EFGH", "--subject", "alice", "--json"]);
    if (unconfirmed.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(unconfirmed.command, unconfirmedIo.value, service)).resolves.toBe(2);
    expect(service.approve).not.toHaveBeenCalled();
    expect(JSON.parse(unconfirmedIo.output[0]!)).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });
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

  it("requires explicit confirmation for installation mutations and preserves canonical JSON", async () => {
    const io = runtime(true);
    const service = backend();
    const denied = parseCommand(["edge", "installation", "retry", "filesystem", "--json"]);
    if (denied.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(denied.command, io.value, service)).resolves.toBe(2);
    expect(service.installation).not.toHaveBeenCalled();
    expect(JSON.parse(io.output[0]!)).toMatchObject({ ok: false, error: { code: "CONFIRMATION_REQUIRED" } });

    const approvedIo = runtime(true);
    const approved = parseCommand(["edge", "installation", "retry", "filesystem", "--yes", "--json"]);
    if (approved.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(approved.command, approvedIo.value, service)).resolves.toBe(0);
    expect(service.installation).toHaveBeenCalledWith("retry", "filesystem", { cleanup: false });
    expect(JSON.parse(approvedIo.output[0]!)).toMatchObject({ ok: true, data: { installation: "ready", setup: "ready", workload: "ready", readiness: "ready" }, pagination: null, warnings: [], nextActions: [] });

    const cleanupApprovalIo = runtime(true);
    const cleanupApproval = parseCommand(["edge", "installation", "approve", "filesystem", "--cleanup", "--yes", "--json"]);
    if (cleanupApproval.kind !== "ok") throw new Error("parse failed");
    await expect(runEdge(cleanupApproval.command, cleanupApprovalIo.value, service)).resolves.toBe(0);
    expect(service.installation).toHaveBeenLastCalledWith("approve", "filesystem", { cleanup: true });
  });
});

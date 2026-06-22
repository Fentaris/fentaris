import { describe, expect, it, vi } from "vitest";
import { Logger } from "@fentaris/core";
import {
  createInMemoryTelegramApprovalStore,
  handleTelegramApprovalCallback,
  telegramApproval,
  type TelegramApprovalDecision,
} from "./index.js";
import type { MiddlewareContext, ToolCallRequest } from "@fentaris/core";

function request(): ToolCallRequest {
  return {
    serverName: "github",
    toolName: "delete_repo",
    proxyToolName: "github__delete_repo",
    arguments: {
      owner: "fentaris",
      repo: "demo",
      token: "raw-token",
      nested: { password: "raw-password" },
    },
    raw: { name: "github__delete_repo" },
  };
}

function context(): MiddlewareContext {
  return {
    user: { id: "alice" },
    subject: {
      id: "alice",
      groups: [],
      hasGroup: () => false,
    },
    log: new Logger({ redact: false }),
    res: {
      deny: vi.fn(),
      fail: vi.fn(),
      continue: vi.fn(),
      injectToAgent: vi.fn(),
      on: vi.fn(),
      notifyError: vi.fn(),
      applyInjections: vi.fn(),
      injectedErrorResult: vi.fn(),
    } as unknown as MiddlewareContext["res"],
  };
}

function okFetch(): ReturnType<typeof vi.fn> {
  return vi.fn(async () => ({ ok: true, status: 200 }));
}

describe("telegramApproval", () => {
  it("sends a Telegram approval request and returns pending metadata", async () => {
    const fetchMock = okFetch();
    const approval = telegramApproval({
      botToken: "bot-token",
      chatId: "chat-1",
      fetch: fetchMock,
      apiBaseUrl: "https://telegram.test",
      requestId: "req-1",
      approvalUrl: (requestId) => `https://approval.test/${requestId}`,
    }).approval;

    const result = await approval?.(request(), context());

    expect(result).toMatchObject({
      status: "pending",
      requestId: "req-1",
      url: "https://approval.test/req-1",
      metadata: { adapter: "telegram" },
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    const body = JSON.parse(init.body as string) as {
      text: string;
      reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
    };
    expect(body.text).toContain("github");
    expect(body.text).toContain("delete_repo");
    expect(body.text).not.toContain("raw-token");
    expect(body.text).not.toContain("raw-password");
    expect(body.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toMatch(/^ft:a:req-1:[A-Za-z0-9_-]{16}$/);
    expect(body.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toMatch(/^ft:d:req-1:[A-Za-z0-9_-]{16}$/);
  });

  it("returns existing store decisions without sending another Telegram message", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore({ "req-2": "approved" });
    const approval = telegramApproval({
      botToken: "bot-token",
      chatId: "chat-1",
      fetch: fetchMock,
      store,
      requestId: "req-2",
    }).approval;

    await expect(approval?.(request(), context())).resolves.toMatchObject({
      status: "approved",
      requestId: "req-2",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("denies Telegram send failures by default", async () => {
    const approval = telegramApproval({
      botToken: "bot-token",
      chatId: "chat-1",
      fetch: vi.fn(async () => ({ ok: false, status: 503 })),
      requestId: "req-failed",
    }).approval;

    await expect(approval?.(request(), context())).resolves.toMatchObject({
      status: "denied",
      reason: "Telegram approval request failed",
      requestId: "req-failed",
      metadata: { adapter: "telegram" },
    });
  });

  it("warns when failOpen is explicitly enabled", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      telegramApproval({
        botToken: "bot-token",
        chatId: "chat-1",
        fetch: okFetch(),
        requestId: "req-fail-open",
        failOpen: true,
      });

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Telegram approval failOpen is enabled"));
    } finally {
      warn.mockRestore();
    }
  });

  it("stores callback decisions and answers Telegram callback queries", async () => {
    const fetchMock = okFetch();
    const callbackData = await signedCallbackData("d", "req-3");
    const decisions = new Map<string, TelegramApprovalDecision>();
    const store = {
      get: (requestId: string) => decisions.get(requestId),
      set: (requestId: string, decision: TelegramApprovalDecision) => {
        decisions.set(requestId, decision);
      },
    };

    const result = await handleTelegramApprovalCallback(
      { callback_query: { id: "callback-1", data: callbackData, message: { chat: { id: "chat-1" } } } },
      { botToken: "bot-token", chatId: "chat-1", store, fetch: fetchMock, apiBaseUrl: "https://telegram.test" },
    );

    expect(result).toEqual({ handled: true, requestId: "req-3", decision: "denied" });
    expect(decisions.get("req-3")).toBe("denied");
    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      callback_query_id: "callback-1",
      text: "Denied",
    });
  });

  it("rejects callbacks from the wrong chat", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();
    const callbackData = await signedCallbackData("a", "req-wrong-chat");

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: callbackData, message: { chat: { id: "other-chat" } } } },
        { botToken: "bot-token", chatId: "chat-1", store, fetch: fetchMock },
      ),
    ).resolves.toEqual({ handled: false });
    expect(await store.get("req-wrong-chat")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects callbacks without chat metadata", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();
    const callbackData = await signedCallbackData("a", "req-missing-chat");

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: callbackData } },
        { botToken: "bot-token", chatId: "chat-1", store, fetch: fetchMock },
      ),
    ).resolves.toEqual({ handled: false });
    expect(await store.get("req-missing-chat")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects webhook callbacks without the configured secret header", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();
    const callbackData = await signedCallbackData("a", "req-missing-secret");

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: callbackData, message: { chat: { id: "chat-1" } } } },
        { botToken: "bot-token", chatId: "chat-1", webhookSecretToken: "webhook-secret", store, fetch: fetchMock },
      ),
    ).resolves.toEqual({ handled: false });
    expect(await store.get("req-missing-secret")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("accepts webhook callbacks with the configured secret header", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();
    const callbackData = await signedCallbackData("a", "req-webhook-secret");

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: callbackData, message: { chat: { id: "chat-1" } } } },
        {
          botToken: "bot-token",
          chatId: "chat-1",
          webhookSecretToken: "webhook-secret",
          headers: { "x-telegram-bot-api-secret-token": "webhook-secret" },
          store,
          fetch: fetchMock,
        },
      ),
    ).resolves.toMatchObject({ handled: true, requestId: "req-webhook-secret", decision: "approved" });
    expect(await store.get("req-webhook-secret")).toBe("approved");
  });

  it("rejects forged request IDs and invalid signatures", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();
    const callbackData = await signedCallbackData("a", "req-original");
    const forgedRequestId = callbackData.replace("req-original", "req-forged");
    const invalidSignature = `${callbackData.slice(0, -1)}${callbackData.endsWith("x") ? "y" : "x"}`;

    for (const data of [forgedRequestId, invalidSignature]) {
      await expect(
        handleTelegramApprovalCallback(
          { callback_query: { id: "callback-1", data, message: { chat: { id: "chat-1" } } } },
          { botToken: "bot-token", chatId: "chat-1", store, fetch: fetchMock },
        ),
      ).resolves.toEqual({ handled: false });
    }

    expect(await store.get("req-original")).toBeUndefined();
    expect(await store.get("req-forged")).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("ignores unrelated Telegram callbacks", async () => {
    const fetchMock = okFetch();
    const store = createInMemoryTelegramApprovalStore();

    await expect(
      handleTelegramApprovalCallback(
        { callback_query: { id: "callback-1", data: "other:data" } },
        { botToken: "bot-token", chatId: "chat-1", store, fetch: fetchMock },
      ),
    ).resolves.toEqual({ handled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

async function signedCallbackData(action: "a" | "d", requestId: string): Promise<string> {
  const fetchMock = okFetch();
  const approval = telegramApproval({
    botToken: "bot-token",
    chatId: "chat-1",
    fetch: fetchMock,
    requestId,
  }).approval;

  await approval?.(request(), context());
  const [, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
  const body = JSON.parse(init.body as string) as {
    reply_markup: { inline_keyboard: Array<Array<{ callback_data: string }>> };
  };
  return action === "a"
    ? body.reply_markup.inline_keyboard[0]?.[0]?.callback_data ?? ""
    : body.reply_markup.inline_keyboard[0]?.[1]?.callback_data ?? "";
}

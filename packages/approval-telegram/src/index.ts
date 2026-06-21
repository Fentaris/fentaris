import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type {
  ApprovalResult,
  MiddlewareContext,
  ToolCallRequest,
  ToolPermissionOptions,
} from "@fentaris/core";

export type TelegramApprovalDecision = "approved" | "denied";

export type TelegramApprovalStore = {
  get(requestId: string): TelegramApprovalDecision | undefined | Promise<TelegramApprovalDecision | undefined>;
  set(requestId: string, decision: TelegramApprovalDecision): void | Promise<void>;
};

export type TelegramApprovalOptions = {
  botToken: string;
  chatId: string | number;
  store?: TelegramApprovalStore;
  apiBaseUrl?: string | URL;
  fetch?: typeof fetch;
  requestId?: string | ((request: ToolCallRequest, context: MiddlewareContext) => string);
  approvalUrl?: string | ((requestId: string, request: ToolCallRequest, context: MiddlewareContext) => string | undefined);
  reason?: string;
  title?: string;
  includeArguments?: boolean;
  maxArgumentLength?: number;
  failOpen?: boolean;
  webhookSecretToken?: string;
};

export type TelegramCallbackHandlerOptions = {
  botToken: string;
  chatId: string | number;
  store: TelegramApprovalStore;
  apiBaseUrl?: string | URL;
  fetch?: typeof fetch;
  webhookSecretToken?: string;
  headers?: TelegramWebhookHeaders;
};

type TelegramCallbackUpdate = {
  callback_query?: {
    id?: string;
    data?: string;
    message?: {
      chat?: {
        id?: string | number;
      };
    };
  };
};

type TelegramWebhookHeaders =
  | Headers
  | Record<string, string | string[] | undefined>
  | Array<[string, string]>;

type CallbackAction = "a" | "d";

const callbackPrefix = "ft";
const telegramWebhookSecretHeader = "x-telegram-bot-api-secret-token";
const defaultApiBaseUrl = "https://api.telegram.org";

/**
 * Create a Fentaris policy approval handler backed by Telegram inline buttons.
 * @pk
 */
export function telegramApproval(options: TelegramApprovalOptions): Pick<ToolPermissionOptions, "approval"> {
  validateOptions(options);
  warnIfFailOpen(options);
  const store = options.store ?? createInMemoryTelegramApprovalStore();
  const fetchImpl = options.fetch ?? fetch;
  const apiBaseUrl = options.apiBaseUrl ?? defaultApiBaseUrl;

  return {
    approval: async (request, context): Promise<ApprovalResult> => {
      const requestId = resolveRequestId(options.requestId, request, context);
      const existingDecision = await store.get(requestId);
      if (existingDecision) {
        return {
          status: existingDecision,
          reason: existingDecision === "approved" ? undefined : options.reason ?? "Telegram approval denied",
          requestId,
        };
      }

      try {
        await sendApprovalMessage({
          botToken: options.botToken,
          chatId: options.chatId,
          apiBaseUrl,
          fetch: fetchImpl,
          requestId,
          signingSecret: options.botToken,
          text: formatApprovalMessage(requestId, request, context, options),
        });
      } catch (error) {
        context.log.error("Telegram approval request failed", {
          error: error instanceof Error ? error.message : String(error),
          requestId,
          serverName: request.serverName,
          toolName: request.toolName,
        });

        return options.failOpen
          ? { status: "approved", reason: "Telegram approval failed open", requestId }
          : {
              status: "denied",
              reason: "Telegram approval request failed",
              requestId,
              metadata: { adapter: "telegram" },
            };
      }

      return {
        status: "pending",
        requestId,
        url: resolveApprovalUrl(options.approvalUrl, requestId, request, context),
        reason: options.reason ?? "Telegram approval is pending",
        metadata: { adapter: "telegram" },
      };
    },
  };
}

/**
 * Create an in-memory decision store suitable for local development and tests.
 * @pk
 */
export function createInMemoryTelegramApprovalStore(initial: Record<string, TelegramApprovalDecision> = {}): TelegramApprovalStore {
  const decisions = new Map<string, TelegramApprovalDecision>(Object.entries(initial));
  return {
    get(requestId) {
      return decisions.get(requestId);
    },
    set(requestId, decision) {
      decisions.set(requestId, decision);
    },
  };
}

/**
 * Handle a Telegram callback_query update and persist the approve/deny decision.
 * @pk
 */
export async function handleTelegramApprovalCallback(
  update: unknown,
  options: TelegramCallbackHandlerOptions,
): Promise<{ handled: boolean; requestId?: string; decision?: TelegramApprovalDecision }> {
  validateCallbackOptions(options);
  if (!isValidWebhookSecret(options)) {
    return { handled: false };
  }

  const callback = (update as TelegramCallbackUpdate | undefined)?.callback_query;
  if (!isConfiguredChat(callback, options.chatId)) {
    return { handled: false };
  }

  const parsed = parseCallbackData(callback?.data, options.botToken);
  if (!parsed) {
    return { handled: false };
  }

  await options.store.set(parsed.requestId, parsed.decision);

  if (callback?.id) {
    await answerCallbackQuery({
      botToken: options.botToken,
      apiBaseUrl: options.apiBaseUrl ?? defaultApiBaseUrl,
      fetch: options.fetch ?? fetch,
      callbackQueryId: callback.id,
      text: parsed.decision === "approved" ? "Approved" : "Denied",
    });
  }

  return { handled: true, requestId: parsed.requestId, decision: parsed.decision };
}

function validateOptions(options: TelegramApprovalOptions): void {
  if (!options.botToken.trim()) {
    throw new Error("Telegram approval botToken is required");
  }
  if (String(options.chatId).trim() === "") {
    throw new Error("Telegram approval chatId is required");
  }
}

function warnIfFailOpen(options: TelegramApprovalOptions): void {
  if (options.failOpen === true) {
    console.warn(
      "Telegram approval failOpen is enabled; approval delivery failures will allow protected calls. Use only for development or emergency break-glass operation.",
    );
  }
}

function validateCallbackOptions(options: TelegramCallbackHandlerOptions): void {
  if (!options.botToken.trim()) {
    throw new Error("Telegram callback botToken is required");
  }
  if (String(options.chatId).trim() === "") {
    throw new Error("Telegram callback chatId is required");
  }
}

function resolveRequestId(
  configured: TelegramApprovalOptions["requestId"],
  request: ToolCallRequest,
  context: MiddlewareContext,
): string {
  const requestId = typeof configured === "function" ? configured(request, context) : configured ?? randomUUID();
  return requestId.length <= 40 ? requestId : createHash("sha256").update(requestId).digest("hex").slice(0, 32);
}

function resolveApprovalUrl(
  configured: TelegramApprovalOptions["approvalUrl"],
  requestId: string,
  request: ToolCallRequest,
  context: MiddlewareContext,
): string | undefined {
  return typeof configured === "function" ? configured(requestId, request, context) : configured;
}

async function sendApprovalMessage(options: {
  botToken: string;
  chatId: string | number;
  apiBaseUrl: string | URL;
  fetch: typeof fetch;
  requestId: string;
  signingSecret: string;
  text: string;
}): Promise<void> {
  const response = await options.fetch(telegramUrl(options.apiBaseUrl, options.botToken, "sendMessage"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      chat_id: options.chatId,
      text: options.text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Approve", callback_data: createCallbackData("a", options.requestId, options.signingSecret) },
            { text: "Deny", callback_data: createCallbackData("d", options.requestId, options.signingSecret) },
          ],
        ],
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram sendMessage failed with status ${response.status}`);
  }
}

async function answerCallbackQuery(options: {
  botToken: string;
  apiBaseUrl: string | URL;
  fetch: typeof fetch;
  callbackQueryId: string;
  text: string;
}): Promise<void> {
  const response = await options.fetch(telegramUrl(options.apiBaseUrl, options.botToken, "answerCallbackQuery"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      callback_query_id: options.callbackQueryId,
      text: options.text,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram answerCallbackQuery failed with status ${response.status}`);
  }
}

function telegramUrl(apiBaseUrl: string | URL, botToken: string, method: string): URL {
  const base = new URL(apiBaseUrl);
  const normalizedPath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  base.pathname = `${normalizedPath}bot${botToken}/${method}`;
  return base;
}

function formatApprovalMessage(
  requestId: string,
  request: ToolCallRequest,
  context: MiddlewareContext,
  options: TelegramApprovalOptions,
): string {
  const title = options.title ?? "Fentaris approval required";
  const lines = [
    `<b>${escapeHtml(title)}</b>`,
    `Request: <code>${escapeHtml(requestId)}</code>`,
    `User: <code>${escapeHtml(context.subject?.id ?? context.user.id ?? "anonymous")}</code>`,
    `Server: <code>${escapeHtml(request.serverName)}</code>`,
    `Tool: <code>${escapeHtml(request.toolName)}</code>`,
  ];

  if (options.includeArguments !== false) {
    lines.push(
      "",
      "<b>Arguments</b>",
      `<pre>${escapeHtml(truncate(JSON.stringify(redactSensitive(request.arguments ?? {}), null, 2), options.maxArgumentLength ?? 1_500))}</pre>`,
    );
  }

  return lines.join("\n");
}

function createCallbackData(action: CallbackAction, requestId: string, signingSecret: string): string {
  return `${callbackPrefix}:${action}:${requestId}:${signCallback(action, requestId, signingSecret)}`;
}

function parseCallbackData(data: string | undefined, signingSecret: string): { requestId: string; decision: TelegramApprovalDecision } | null {
  if (!data) {
    return null;
  }

  const [prefix, action, requestId, signature, ...extra] = data.split(":");
  if (
    prefix !== callbackPrefix ||
    extra.length > 0 ||
    (action !== "a" && action !== "d") ||
    !requestId ||
    !signature ||
    !isValidSignature(action, requestId, signature, signingSecret)
  ) {
    return null;
  }

  return { decision: action === "a" ? "approved" : "denied", requestId };
}

function signCallback(action: CallbackAction, requestId: string, signingSecret: string): string {
  return createHmac("sha256", signingSecret)
    .update(`${action}:${requestId}`)
    .digest("base64url")
    .slice(0, 16);
}

function isValidSignature(action: CallbackAction, requestId: string, signature: string, signingSecret: string): boolean {
  return timingSafeEqualString(signature, signCallback(action, requestId, signingSecret));
}

function isConfiguredChat(
  callback: TelegramCallbackUpdate["callback_query"] | undefined,
  configuredChatId: string | number,
): boolean {
  const callbackChatId = callback?.message?.chat?.id;
  return callbackChatId !== undefined && String(callbackChatId) === String(configuredChatId);
}

function isValidWebhookSecret(options: TelegramCallbackHandlerOptions): boolean {
  if (!options.webhookSecretToken) {
    return true;
  }

  const provided = readHeader(options.headers, telegramWebhookSecretHeader);
  return provided !== undefined && timingSafeEqualString(provided, options.webhookSecretToken);
}

function readHeader(headers: TelegramWebhookHeaders | undefined, name: string): string | undefined {
  if (!headers) {
    return undefined;
  }
  if (headers instanceof Headers) {
    return headers.get(name) ?? undefined;
  }
  if (Array.isArray(headers)) {
    const match = headers.find(([key]) => key.toLowerCase() === name);
    return match?.[1];
  }

  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  return Array.isArray(value) ? value[0] : value;
}

function timingSafeEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitive(item));
  }
  if (!value || typeof value !== "object") {
    return value;
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      /(token|secret|password|authorization|api[-_]?key|credential)/i.test(key) ? "[REDACTED]" : redactSensitive(nested),
    ]),
  );
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxLength - 15))}\n... truncated`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

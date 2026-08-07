/**
 * Public integrated Edge control-plane configuration contracts, normalization,
 * and fail-closed validation.
 * @pk
 */

import { isIP } from "node:net";
import { diagnostic, type FentarisDiagnostic } from "../config/diagnostics.js";
import type {
  EdgeCapabilityManifestStore,
  EdgeChannelBroker,
  EdgeConnectionStore,
  EdgeDesiredStateStore,
  EdgeDeviceRegistry,
  EdgeSetupStatusStore,
} from "./controlPlane.js";
import type {
  EdgeAdapterDiagnostics,
  EdgeChildBindingStore,
  EdgePresenceStore,
  EdgeReadinessStore,
  EdgeSessionSelectionStore,
} from "./inventory.js";
import type {
  EdgeDesiredAssignmentStore,
  EdgeDeviceAuthorizationService,
  EdgeEnrollmentService,
  EdgeTokenIssuanceService,
} from "./integratedServices.js";

/** Integrated control-plane deployment mode. @pk */
export type EdgeControlPlaneMode = "local" | "managed";

/** Default reserved HTTP base path for integrated Edge routes. @pk */
export const EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH = "/_fentaris/edge" as const;

/** Default local state directory relative to the project auth directory. @pk */
export const EDGE_CONTROL_PLANE_DEFAULT_STATE_DIR = "edge-control-plane" as const;

/** Documented secure defaults applied when local mode omits optional limits. @pk */
export const EDGE_CONTROL_PLANE_DEFAULTS = Object.freeze({
  basePath: EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH,
  stateDir: EDGE_CONTROL_PLANE_DEFAULT_STATE_DIR,
  accessTokenTtlSeconds: 15 * 60,
  refreshTokenTtlSeconds: 30 * 24 * 60 * 60,
  authorizationCodeTtlSeconds: 10 * 60,
  pollIntervalSeconds: 5,
  maxPollAttempts: 120,
  maxRequestBytes: 16_384,
  maxMetadataBytes: 4_096,
  rateLimitPerMinute: 60,
} as const);

/**
 * Serializable Edge control-plane fields that may appear in `fentaris.json`.
 * Adapter implementations and approval callbacks remain TypeScript-only.
 * @pk
 */
export type SerializableEdgeControlPlaneConfig = {
  readonly enabled?: boolean;
  readonly mode?: EdgeControlPlaneMode;
  readonly basePath?: string;
  readonly publicOrigin?: string;
  /** Directory under the project auth boundary for local durable state. @pk */
  readonly stateDir?: string;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
  readonly authorizationCodeTtlSeconds?: number;
  readonly pollIntervalSeconds?: number;
  readonly maxPollAttempts?: number;
  readonly maxRequestBytes?: number;
  readonly maxMetadataBytes?: number;
  readonly rateLimitPerMinute?: number;
};

/** Approval decision recorded for an exact pending device-authorization request. @pk */
export type EdgeDeviceApprovalDecision = {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly actorId: string;
  readonly approvedAt: number;
  readonly notes?: string;
};

/** Replaceable approval adapter used by managed consoles or identity systems. @pk */
export interface EdgeDeviceApprovalAdapter {
  readonly diagnostics?: EdgeAdapterDiagnostics;
  approve(userCode: string, decision: EdgeDeviceApprovalDecision): Promise<void>;
  deny?(userCode: string, decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string }): Promise<void>;
}

/**
 * Optional managed assignment resolver for subjects that cannot be enumerated
 * statically from application configuration.
 * @pk
 */
export interface EdgeAssignmentResolver {
  readonly diagnostics?: EdgeAdapterDiagnostics;
  resolveEligibleDevices(input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly serverName: string;
    readonly deploymentId: string;
  }): Promise<readonly string[]>;
}

/** Managed authorization/enrollment services owned by the deployment identity boundary. @pk */
export type EdgeControlPlaneManagedServices = {
  readonly authorization: EdgeDeviceAuthorizationService;
  readonly tokens: EdgeTokenIssuanceService;
  readonly enrollment: EdgeEnrollmentService;
};

/** Durable/managed adapters required when `mode: "managed"`. @pk */
export type EdgeControlPlaneManagedAdapters = {
  readonly deviceRegistry: EdgeDeviceRegistry;
  readonly desiredStateStore: EdgeDesiredStateStore;
  readonly setupStatusStore: EdgeSetupStatusStore;
  readonly capabilityManifestStore: EdgeCapabilityManifestStore;
  readonly connectionStore: EdgeConnectionStore;
  readonly presenceStore: EdgePresenceStore;
  readonly readinessStore: EdgeReadinessStore;
  readonly assignmentStore: EdgeDesiredAssignmentStore;
  readonly services: EdgeControlPlaneManagedServices;
  readonly sessionSelectionStore?: EdgeSessionSelectionStore;
  readonly childBindingStore?: EdgeChildBindingStore;
  readonly channelBroker?: EdgeChannelBroker;
  readonly approval?: EdgeDeviceApprovalAdapter;
  readonly assignmentResolver?: EdgeAssignmentResolver;
};

/**
 * Public application configuration for the integrated Edge control plane.
 * Omitting this object preserves today's low-level `edge` wiring.
 * @pk
 */
export type EdgeControlPlaneConfig =
  | {
      readonly enabled?: false;
    }
  | ({
      readonly enabled: true;
      readonly mode: "local";
      readonly adapters?: Partial<EdgeControlPlaneManagedAdapters>;
      readonly approval?: EdgeDeviceApprovalAdapter;
      readonly assignmentResolver?: EdgeAssignmentResolver;
    } & SerializableEdgeControlPlaneConfig)
  | ({
      readonly enabled: true;
      readonly mode: "managed";
      readonly adapters: EdgeControlPlaneManagedAdapters;
      readonly approval?: EdgeDeviceApprovalAdapter;
      readonly assignmentResolver?: EdgeAssignmentResolver;
    } & SerializableEdgeControlPlaneConfig);

/**
 * Normalized runtime configuration after merge and defaults. Present only when
 * the integrated control plane is enabled.
 * @pk
 */
export type NormalizedEdgeControlPlaneConfig = {
  readonly enabled: true;
  readonly mode: EdgeControlPlaneMode;
  readonly basePath: string;
  readonly publicOrigin?: string;
  readonly stateDir: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly authorizationCodeTtlSeconds: number;
  readonly pollIntervalSeconds: number;
  readonly maxPollAttempts: number;
  readonly maxRequestBytes: number;
  readonly maxMetadataBytes: number;
  readonly rateLimitPerMinute: number;
  readonly adapters?: Partial<EdgeControlPlaneManagedAdapters>;
  readonly approval?: EdgeDeviceApprovalAdapter;
  readonly assignmentResolver?: EdgeAssignmentResolver;
};

/** Keys that may be supplied through serializable project configuration. @pk */
export const SERIALIZABLE_EDGE_CONTROL_PLANE_KEYS = Object.freeze([
  "enabled",
  "mode",
  "basePath",
  "publicOrigin",
  "stateDir",
  "accessTokenTtlSeconds",
  "refreshTokenTtlSeconds",
  "authorizationCodeTtlSeconds",
  "pollIntervalSeconds",
  "maxPollAttempts",
  "maxRequestBytes",
  "maxMetadataBytes",
  "rateLimitPerMinute",
] as const satisfies ReadonlyArray<keyof SerializableEdgeControlPlaneConfig>);

const SENSITIVE_CONFIG_KEYS = Object.freeze([
  "signingKey",
  "privateKey",
  "tokenSecret",
  "deviceCredential",
  "refreshToken",
  "accessToken",
  "secret",
  "password",
] as const);

/**
 * Merge serializable `fentaris.json` Edge control-plane options with TypeScript
 * config. TypeScript wins for every overlapping serializable field; adapters
 * and callbacks are TypeScript-only and are never taken from JSON.
 * @pk
 */
export function mergeEdgeControlPlaneConfig(
  typescriptConfig: EdgeControlPlaneConfig | undefined,
  jsonConfig: SerializableEdgeControlPlaneConfig | undefined,
): EdgeControlPlaneConfig | undefined {
  if (!typescriptConfig && !jsonConfig) {
    return undefined;
  }

  const fromJson = pickSerializable(jsonConfig);
  const fromTs = pickSerializable(
    typescriptConfig && "enabled" in typescriptConfig && typescriptConfig.enabled === false
      ? { enabled: false }
      : (typescriptConfig as SerializableEdgeControlPlaneConfig | undefined),
  );

  const mergedSerializable: SerializableEdgeControlPlaneConfig = {
    ...fromJson,
    ...fromTs,
  };

  if (mergedSerializable.enabled !== true) {
    return { enabled: false };
  }

  const mode = mergedSerializable.mode ?? (typescriptConfig && "mode" in typescriptConfig ? typescriptConfig.mode : undefined);
  if (mode !== "local" && mode !== "managed") {
    return {
      ...mergedSerializable,
      enabled: true,
      mode: "local",
      ...(typescriptConfig && "approval" in typescriptConfig ? { approval: typescriptConfig.approval } : {}),
      ...(typescriptConfig && "assignmentResolver" in typescriptConfig
        ? { assignmentResolver: typescriptConfig.assignmentResolver }
        : {}),
      ...(typescriptConfig && "adapters" in typescriptConfig ? { adapters: typescriptConfig.adapters } : {}),
    };
  }

  if (mode === "managed") {
    return {
      ...mergedSerializable,
      enabled: true,
      mode: "managed",
      adapters: (typescriptConfig && "adapters" in typescriptConfig
        ? typescriptConfig.adapters
        : undefined) as EdgeControlPlaneManagedAdapters,
      ...(typescriptConfig && "approval" in typescriptConfig ? { approval: typescriptConfig.approval } : {}),
      ...(typescriptConfig && "assignmentResolver" in typescriptConfig
        ? { assignmentResolver: typescriptConfig.assignmentResolver }
        : {}),
    };
  }

  return {
    ...mergedSerializable,
    enabled: true,
    mode: "local",
    ...(typescriptConfig && "adapters" in typescriptConfig ? { adapters: typescriptConfig.adapters } : {}),
    ...(typescriptConfig && "approval" in typescriptConfig ? { approval: typescriptConfig.approval } : {}),
    ...(typescriptConfig && "assignmentResolver" in typescriptConfig
      ? { assignmentResolver: typescriptConfig.assignmentResolver }
      : {}),
  };
}

/**
 * Normalize an enabled control-plane configuration with secure defaults.
 * Returns `undefined` when the control plane is absent or disabled.
 * @pk
 */
export function normalizeEdgeControlPlaneConfig(
  config: EdgeControlPlaneConfig | undefined,
): NormalizedEdgeControlPlaneConfig | undefined {
  if (!config || config.enabled !== true) {
    return undefined;
  }

  return {
    enabled: true,
    mode: config.mode,
    basePath: normalizeBasePath(config.basePath ?? EDGE_CONTROL_PLANE_DEFAULTS.basePath),
    ...(config.publicOrigin !== undefined ? { publicOrigin: config.publicOrigin.trim() } : {}),
    stateDir: (config.stateDir ?? EDGE_CONTROL_PLANE_DEFAULTS.stateDir).trim() || EDGE_CONTROL_PLANE_DEFAULTS.stateDir,
    accessTokenTtlSeconds: positiveInt(config.accessTokenTtlSeconds, EDGE_CONTROL_PLANE_DEFAULTS.accessTokenTtlSeconds),
    refreshTokenTtlSeconds: positiveInt(config.refreshTokenTtlSeconds, EDGE_CONTROL_PLANE_DEFAULTS.refreshTokenTtlSeconds),
    authorizationCodeTtlSeconds: positiveInt(
      config.authorizationCodeTtlSeconds,
      EDGE_CONTROL_PLANE_DEFAULTS.authorizationCodeTtlSeconds,
    ),
    pollIntervalSeconds: positiveInt(config.pollIntervalSeconds, EDGE_CONTROL_PLANE_DEFAULTS.pollIntervalSeconds),
    maxPollAttempts: positiveInt(config.maxPollAttempts, EDGE_CONTROL_PLANE_DEFAULTS.maxPollAttempts),
    maxRequestBytes: positiveInt(config.maxRequestBytes, EDGE_CONTROL_PLANE_DEFAULTS.maxRequestBytes),
    maxMetadataBytes: positiveInt(config.maxMetadataBytes, EDGE_CONTROL_PLANE_DEFAULTS.maxMetadataBytes),
    rateLimitPerMinute: positiveInt(config.rateLimitPerMinute, EDGE_CONTROL_PLANE_DEFAULTS.rateLimitPerMinute),
    ...(config.adapters ? { adapters: config.adapters } : {}),
    ...(config.approval ? { approval: config.approval } : {}),
    ...(config.assignmentResolver ? { assignmentResolver: config.assignmentResolver } : {}),
  };
}

/**
 * Validate integrated Edge control-plane configuration. Callers supply the MCP
 * path and optional listener host so route conflicts and loopback origin rules
 * can be evaluated before startup.
 * @pk
 */
export function validateEdgeControlPlaneConfig(
  config: EdgeControlPlaneConfig | undefined,
  options: {
    readonly mcpPath?: string;
    readonly listenerHost?: string;
    readonly authDir?: string;
  } = {},
): FentarisDiagnostic[] {
  const diagnostics: FentarisDiagnostic[] = [];
  if (!config) {
    return diagnostics;
  }

  const pathPrefix = ["edge", "controlPlane"] as const;
  rejectSensitiveEmbeddedValues(config as Record<string, unknown>, [...pathPrefix], diagnostics);

  if (config.enabled !== true) {
    return diagnostics;
  }

  if (config.mode !== "local" && config.mode !== "managed") {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_MODE_INVALID",
      "Invalid Edge control-plane mode",
      'edge.controlPlane.mode must be "local" or "managed".',
      { path: [...pathPrefix, "mode"] },
    ));
    return diagnostics;
  }

  const normalized = normalizeEdgeControlPlaneConfig(config);
  if (!normalized) {
    return diagnostics;
  }

  validateBasePath(normalized.basePath, options.mcpPath, diagnostics);
  validatePublicOrigin(normalized, options.listenerHost, diagnostics);
  validateNumericLimits(normalized, diagnostics);

  if (normalized.mode === "local") {
    validateLocalStateDir(normalized.stateDir, options.authDir, diagnostics);
    if (normalized.adapters) {
      diagnostics.push(...diagnoseReferenceAdaptersInManagedRoles(normalized.adapters, "local"));
    }
  } else {
    validateManagedAdapters(normalized, diagnostics);
  }

  return diagnostics;
}

/**
 * Parse serializable Edge control-plane options from raw `fentaris.json` input.
 * Unknown adapter-like keys are rejected rather than silently ignored.
 * @pk
 */
export function parseSerializableEdgeControlPlaneConfig(
  value: unknown,
  diagnostics: FentarisDiagnostic[] = [],
  path: Array<string | number> = ["edge", "controlPlane"],
): SerializableEdgeControlPlaneConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_INVALID_SHAPE",
      "Edge control-plane config must be an object",
      "Configure edge.controlPlane as an object in fentaris.json or TypeScript.",
      { path },
    ));
    return undefined;
  }

  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (!(SERIALIZABLE_EDGE_CONTROL_PLANE_KEYS as readonly string[]).includes(key)) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_JSON_UNSUPPORTED_FIELD",
        "Unsupported Edge control-plane field in serializable config",
        `Field "${key}" cannot be supplied through fentaris.json. Adapters and callbacks are TypeScript-only.`,
        {
          path: [...path, key],
          hint: "Move adapter and approval configuration into the TypeScript fentaris({ edge: { controlPlane } }) options.",
        },
      ));
    }
  }

  rejectSensitiveEmbeddedValues(input, path, diagnostics);

  const result: SerializableEdgeControlPlaneConfig = {
    ...(typeof input.enabled === "boolean" ? { enabled: input.enabled } : {}),
    ...(input.mode === "local" || input.mode === "managed" ? { mode: input.mode } : {}),
    ...(typeof input.basePath === "string" ? { basePath: input.basePath } : {}),
    ...(typeof input.publicOrigin === "string" ? { publicOrigin: input.publicOrigin } : {}),
    ...(typeof input.stateDir === "string" ? { stateDir: input.stateDir } : {}),
    ...optionalPositiveNumber(input, "accessTokenTtlSeconds"),
    ...optionalPositiveNumber(input, "refreshTokenTtlSeconds"),
    ...optionalPositiveNumber(input, "authorizationCodeTtlSeconds"),
    ...optionalPositiveNumber(input, "pollIntervalSeconds"),
    ...optionalPositiveNumber(input, "maxPollAttempts"),
    ...optionalPositiveNumber(input, "maxRequestBytes"),
    ...optionalPositiveNumber(input, "maxMetadataBytes"),
    ...optionalPositiveNumber(input, "rateLimitPerMinute"),
  };

  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_ENABLED_INVALID",
      "Invalid Edge control-plane enabled flag",
      "edge.controlPlane.enabled must be a boolean.",
      { path: [...path, "enabled"] },
    ));
  }
  if (input.mode !== undefined && input.mode !== "local" && input.mode !== "managed") {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_MODE_INVALID",
      "Invalid Edge control-plane mode",
      'edge.controlPlane.mode must be "local" or "managed".',
      { path: [...path, "mode"] },
    ));
  }

  return result;
}

/** Build absolute join and gateway URLs from a validated canonical public origin. @pk */
export function buildEdgeControlPlaneUrls(
  publicOrigin: string,
  basePath: string,
): {
  readonly joinBaseUrl: string;
  readonly gatewayUrl: string;
  readonly authorizeUrl: string;
  readonly tokenUrl: string;
  readonly refreshUrl: string;
  readonly enrollUrl: string;
  readonly revokeUrl: string;
  readonly verificationUrl: string;
} {
  const origin = new URL(publicOrigin);
  const normalizedBase = normalizeBasePath(basePath);
  const joinBaseUrl = new URL(normalizedBase, origin).toString().replace(/\/$/, "");
  const gatewayProtocol = origin.protocol === "https:" ? "wss:" : "ws:";
  const gatewayUrl = `${gatewayProtocol}//${origin.host}${normalizedBase}/ws`;
  return {
    joinBaseUrl,
    gatewayUrl,
    authorizeUrl: `${joinBaseUrl}/device/authorize`,
    tokenUrl: `${joinBaseUrl}/device/token`,
    refreshUrl: `${joinBaseUrl}/token/refresh`,
    enrollUrl: `${joinBaseUrl}/edge/enroll`,
    revokeUrl: `${joinBaseUrl}/edge/revoke`,
    verificationUrl: `${joinBaseUrl}/device/verify`,
  };
}

function pickSerializable(
  config: SerializableEdgeControlPlaneConfig | undefined,
): SerializableEdgeControlPlaneConfig {
  if (!config) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of SERIALIZABLE_EDGE_CONTROL_PLANE_KEYS) {
    const value = config[key];
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result as SerializableEdgeControlPlaneConfig;
}

function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim();
  if (!trimmed) {
    return EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH;
  }
  const withSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withSlash.replace(/\/+$/, "") || EDGE_CONTROL_PLANE_DEFAULT_BASE_PATH;
}

function positiveInt(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveNumber(
  input: Record<string, unknown>,
  key: keyof SerializableEdgeControlPlaneConfig,
): Partial<SerializableEdgeControlPlaneConfig> {
  const value = input[key];
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return { [key]: value } as Partial<SerializableEdgeControlPlaneConfig>;
  }
  return {};
}

function validateBasePath(
  basePath: string,
  mcpPath: string | undefined,
  diagnostics: FentarisDiagnostic[],
): void {
  const path = ["edge", "controlPlane", "basePath"] as const;
  if (!basePath.startsWith("/") || basePath === "/" || basePath.includes("//") || /[?#]/.test(basePath)) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_BASE_PATH_INVALID",
      "Invalid Edge control-plane base path",
      "edge.controlPlane.basePath must be a non-root absolute path without query or fragment components.",
      { path: [...path] },
    ));
    return;
  }

  if (mcpPath) {
    const normalizedMcp = mcpPath.startsWith("/") ? mcpPath.replace(/\/+$/, "") || "/" : `/${mcpPath}`;
    if (
      basePath === normalizedMcp
      || basePath.startsWith(`${normalizedMcp}/`)
      || normalizedMcp.startsWith(`${basePath}/`)
    ) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_ROUTE_CONFLICT",
        "Edge control-plane path conflicts with MCP endpoint",
        `Edge base path "${basePath}" overlaps MCP path "${normalizedMcp}".`,
        {
          path: [...path],
          hint: "Choose a reserved path such as /_fentaris/edge that does not overlap the MCP endpoint.",
        },
      ));
    }
  }
}

function validatePublicOrigin(
  config: NormalizedEdgeControlPlaneConfig,
  listenerHost: string | undefined,
  diagnostics: FentarisDiagnostic[],
): void {
  const path = ["edge", "controlPlane", "publicOrigin"] as const;
  if (!config.publicOrigin) {
    if (config.mode === "managed") {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_REQUIRED",
        "Managed Edge control plane requires a public origin",
        "Configure edge.controlPlane.publicOrigin to a canonical HTTPS origin.",
        { path: [...path] },
      ));
      return;
    }
    if (listenerHost && !isLoopbackHost(listenerHost)) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_REQUIRED",
        "Non-loopback Edge listeners require a public origin",
        "Configure edge.controlPlane.publicOrigin; Fentaris never derives enrollment URLs from Host or forwarded headers.",
        { path: [...path] },
      ));
    }
    return;
  }

  let origin: URL;
  try {
    origin = new URL(config.publicOrigin);
  } catch {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_INVALID",
      "Invalid Edge public origin",
      "edge.controlPlane.publicOrigin must be an absolute URL origin.",
      { path: [...path] },
    ));
    return;
  }

  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_INVALID",
      "Invalid Edge public origin",
      "edge.controlPlane.publicOrigin must be a bare origin without path, credentials, query, or fragment.",
      { path: [...path] },
    ));
  }

  const loopback = isLoopbackHost(origin.hostname);
  if (!loopback && origin.protocol !== "https:") {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_INSECURE",
      "Insecure Edge public origin",
      "Non-loopback Edge public origins must use HTTPS so enrollment and gateway URLs remain WSS-capable.",
      {
        path: [...path],
        hint: "Terminate TLS at the application or a trusted reverse proxy and declare the canonical HTTPS origin.",
      },
    ));
  }
  if (loopback && origin.protocol !== "http:" && origin.protocol !== "https:") {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_PUBLIC_ORIGIN_INVALID",
      "Invalid Edge public origin protocol",
      "Loopback Edge public origins must use http: or https:.",
      { path: [...path] },
    ));
  }
}

function validateNumericLimits(
  config: NormalizedEdgeControlPlaneConfig,
  diagnostics: FentarisDiagnostic[],
): void {
  const checks: Array<[keyof NormalizedEdgeControlPlaneConfig, number]> = [
    ["accessTokenTtlSeconds", config.accessTokenTtlSeconds],
    ["refreshTokenTtlSeconds", config.refreshTokenTtlSeconds],
    ["authorizationCodeTtlSeconds", config.authorizationCodeTtlSeconds],
    ["pollIntervalSeconds", config.pollIntervalSeconds],
    ["maxPollAttempts", config.maxPollAttempts],
    ["maxRequestBytes", config.maxRequestBytes],
    ["maxMetadataBytes", config.maxMetadataBytes],
    ["rateLimitPerMinute", config.rateLimitPerMinute],
  ];
  for (const [key, value] of checks) {
    if (!Number.isInteger(value) || value <= 0) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_LIMIT_INVALID",
        "Invalid Edge control-plane limit",
        `edge.controlPlane.${key} must be a positive integer.`,
        { path: ["edge", "controlPlane", key] },
      ));
    }
  }
}

function validateLocalStateDir(
  stateDir: string,
  authDir: string | undefined,
  diagnostics: FentarisDiagnostic[],
): void {
  const path = ["edge", "controlPlane", "stateDir"] as const;
  if (!stateDir || stateDir.includes("\0") || stateDir === "/" || stateDir.startsWith("/") || /^[A-Za-z]:[\\/]/.test(stateDir)) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_STATE_DIR_INVALID",
      "Invalid local Edge state directory",
      "edge.controlPlane.stateDir must be a relative path under the project auth boundary.",
      {
        path: [...path],
        hint: authDir
          ? `Use a relative directory under ${authDir}, for example edge-control-plane.`
          : "Use a relative directory such as edge-control-plane under the configured authDir.",
      },
    ));
    return;
  }
  if (stateDir.split(/[\\/]/).some((part) => part === "..")) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_STATE_DIR_ESCAPES_AUTH",
      "Local Edge state directory escapes the auth boundary",
      "edge.controlPlane.stateDir must not contain parent-directory segments.",
      { path: [...path] },
    ));
  }
}

function validateManagedAdapters(
  config: NormalizedEdgeControlPlaneConfig,
  diagnostics: FentarisDiagnostic[],
): void {
  const required = [
    "deviceRegistry",
    "desiredStateStore",
    "setupStatusStore",
    "capabilityManifestStore",
    "connectionStore",
    "presenceStore",
    "readinessStore",
    "assignmentStore",
    "services",
  ] as const;

  if (!config.adapters) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_MANAGED_ADAPTERS_MISSING",
      "Managed Edge mode requires durable adapters",
      "Provide edge.controlPlane.adapters for every durable store required by managed mode.",
      { path: ["edge", "controlPlane", "adapters"] },
    ));
    return;
  }

  for (const key of required) {
    if (!config.adapters[key]) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_MANAGED_ADAPTER_MISSING",
        "Missing managed Edge adapter",
        `Managed mode requires adapters.${key}.`,
        { path: ["edge", "controlPlane", "adapters", key] },
      ));
    }
  }

  diagnostics.push(...diagnoseReferenceAdaptersInManagedRoles(config.adapters, "managed"));

  if (!config.approval && !config.adapters.approval) {
    diagnostics.push(diagnostic(
      "error",
      "FENTARIS_EDGE_CONTROL_PLANE_APPROVAL_ADAPTER_MISSING",
      "Managed Edge mode requires an approval adapter",
      "Provide edge.controlPlane.approval or adapters.approval backed by the managed authorization console.",
      { path: ["edge", "controlPlane", "approval"] },
    ));
  }
}

function diagnoseReferenceAdaptersInManagedRoles(
  adapters: Partial<EdgeControlPlaneManagedAdapters>,
  mode: EdgeControlPlaneMode,
): FentarisDiagnostic[] {
  const diagnostics: FentarisDiagnostic[] = [];
  for (const [name, adapter] of Object.entries(adapters)) {
    const diagnosticsField = adapter && typeof adapter === "object" && "diagnostics" in adapter
      ? (adapter as { diagnostics?: EdgeAdapterDiagnostics }).diagnostics
      : undefined;
    if (!diagnosticsField) {
      continue;
    }
    if (mode === "managed" && (!diagnosticsField.durable || !diagnosticsField.multiInstance || !diagnosticsField.productionReady)) {
      diagnostics.push(diagnostic(
        "error",
        "FENTARIS_EDGE_CONTROL_PLANE_MANAGED_ADAPTER_UNSAFE",
        "Managed Edge adapter lacks required guarantees",
        `adapters.${name} reports durable=${diagnosticsField.durable}, multiInstance=${diagnosticsField.multiInstance}, productionReady=${diagnosticsField.productionReady}.`,
        {
          path: ["edge", "controlPlane", "adapters", name],
          hint: "Replace in-memory or single-process reference adapters with durable distributed managed adapters.",
        },
      ));
    }
  }
  return diagnostics;
}

function rejectSensitiveEmbeddedValues(
  value: unknown,
  path: Array<string | number>,
  diagnostics: FentarisDiagnostic[],
): void {
  if (!value || typeof value !== "object") {
    return;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const nextPath = [...path, key];
    if (SENSITIVE_CONFIG_KEYS.some((candidate) => key.toLowerCase().includes(candidate.toLowerCase()))) {
      if (typeof nested === "string" && nested.trim().length > 0) {
        diagnostics.push(diagnostic(
          "error",
          "FENTARIS_EDGE_CONTROL_PLANE_SENSITIVE_VALUE",
          "Sensitive Edge value embedded in configuration",
          `Configuration field "${key}" must not embed protected Edge secrets.`,
          {
            path: nextPath,
            hint: "Use Fentaris protected secrets or managed adapters; never place signing keys, tokens, or device credentials in config.",
          },
        ));
      }
    }
    if (nested && typeof nested === "object" && !Array.isArray(nested)) {
      rejectSensitiveEmbeddedValues(nested, nextPath, diagnostics);
    }
  }
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (normalized === "localhost" || normalized === "::1") {
    return true;
  }
  if (isIP(normalized) === 4) {
    return normalized.startsWith("127.");
  }
  if (isIP(normalized) === 6) {
    return normalized === "::1" || normalized.endsWith("::1");
  }
  return false;
}

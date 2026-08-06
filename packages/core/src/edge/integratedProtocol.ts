/**
 * Bounded HTTP/protocol contracts for the integrated Edge control plane.
 * These mirror the request/response shapes already expected by
 * `@fentaris/edge` enrollment clients.
 * @pk
 */

/** Stable control-plane error codes returned to Edge clients. @pk */
export const EDGE_CONTROL_PLANE_ERROR_CODES = Object.freeze({
  invalid_request: "invalid_request",
  unauthorized: "unauthorized",
  authorization_pending: "authorization_pending",
  slow_down: "slow_down",
  access_denied: "access_denied",
  expired_token: "expired_token",
  invalid_grant: "invalid_grant",
  revoked: "revoked",
  rate_limited: "rate_limited",
  payload_too_large: "payload_too_large",
  server_error: "server_error",
} as const);

export type EdgeControlPlaneErrorCode =
  (typeof EDGE_CONTROL_PLANE_ERROR_CODES)[keyof typeof EDGE_CONTROL_PLANE_ERROR_CODES];

/** Confidential control-plane error body. Never includes secrets or existence proofs. @pk */
export type EdgeControlPlaneErrorBody = {
  readonly error: EdgeControlPlaneErrorCode;
  readonly error_description?: string;
  readonly interval?: number;
};

/** Device authorization creation request. @pk */
export type EdgeDeviceAuthorizeRequest = {
  readonly clientId: string;
  readonly tenantId?: string;
  readonly metadata?: Readonly<Record<string, string>>;
};

/** Device authorization creation response. @pk */
export type EdgeDeviceAuthorizeResponse = {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
};

/** Device token poll request. @pk */
export type EdgeDeviceTokenRequest = {
  readonly clientId: string;
  readonly deviceCode: string;
};

/** Successful token issuance shared by poll and refresh. @pk */
export type EdgeControlPlaneTokenResponse = {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
  readonly tokenType: "Bearer";
};

/** Refresh-token rotation request. @pk */
export type EdgeTokenRefreshRequest = {
  readonly clientId: string;
  readonly refreshToken: string;
};

/** Enrollment request carrying proof of possession for the device key. @pk */
export type EdgeEnrollRequest = {
  readonly accessToken: string;
  readonly publicKey: string;
  readonly deviceCode: string;
  readonly nonce: string;
  readonly proof: string;
  readonly hostnameLabel?: string;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
};

/** Enrollment success response. @pk */
export type EdgeEnrollResponse = {
  readonly edgeNodeId: string;
  readonly tenantId: string;
  readonly gatewayUrl: string;
  readonly deviceCredential: string;
};

/** Operator or self-revocation request. @pk */
export type EdgeRevokeRequest = {
  readonly edgeNodeId: string;
};

/**
 * Authenticated gateway hello envelope fields required by the integrated
 * control plane. Protocol-v2 message contracts remain unchanged; this documents
 * the proof-carrying fields the gateway validates.
 * @pk
 */
export type EdgeAuthenticatedHelloProof = {
  readonly edgeNodeId: string;
  readonly tenantId: string;
  readonly nonce: string;
  readonly proof: string;
  readonly deviceCredential: string;
  readonly protocolVersions: readonly number[];
};

/** Result of validating an authenticated hello proof. @pk */
export type EdgeAuthenticatedHelloResult =
  | {
      readonly status: "accepted";
      readonly tenantId: string;
      readonly edgeNodeId: string;
      readonly credentialId: string;
      readonly connectionGeneration: number;
      readonly protocolVersion: number;
    }
  | {
      readonly status: "rejected";
      readonly error: EdgeControlPlaneErrorCode;
    };

/** Type guard for a control-plane error body. @pk */
export function isEdgeControlPlaneErrorBody(value: unknown): value is EdgeControlPlaneErrorBody {
  return Boolean(
    value
    && typeof value === "object"
    && typeof (value as EdgeControlPlaneErrorBody).error === "string"
    && (value as EdgeControlPlaneErrorBody).error in EDGE_CONTROL_PLANE_ERROR_CODES,
  );
}

/** Build a redacted control-plane error body. @pk */
export function edgeControlPlaneError(
  error: EdgeControlPlaneErrorCode,
  description?: string,
  extras: { readonly interval?: number } = {},
): EdgeControlPlaneErrorBody {
  return {
    error,
    ...(description ? { error_description: description } : {}),
    ...(extras.interval !== undefined ? { interval: extras.interval } : {}),
  };
}

/**
 * Device authorization, approval, token issuance, enrollment, and revocation
 * services for the integrated Edge control plane.
 * @pk
 */

import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  buildEdgeControlPlaneUrls,
  type EdgeDeviceApprovalDecision,
  type NormalizedEdgeControlPlaneConfig,
} from "./integratedConfig.js";
import {
  EDGE_CONTROL_PLANE_ERROR_CODES,
  edgeControlPlaneError,
  type EdgeAuthenticatedHelloProof,
  type EdgeAuthenticatedHelloResult,
  type EdgeControlPlaneTokenResponse,
  type EdgeDeviceAuthorizeRequest,
  type EdgeDeviceAuthorizeResponse,
  type EdgeDeviceTokenRequest,
  type EdgeEnrollRequest,
  type EdgeEnrollResponse,
  type EdgeRevokeRequest,
  type EdgeTokenRefreshRequest,
} from "./integratedProtocol.js";
import type {
  EdgeApprovalService,
  EdgeAuthorizationSession,
  EdgeDeviceAuthorizationService,
  EdgeEnrollmentService,
  EdgeTokenIssuanceService,
  EdgeEnrolledDeviceAuthority,
} from "./integratedServices.js";
import {
  EdgeLocalAuthorityStore,
  compareSecretHash,
  hashSecret,
  normalizeUserCode,
  redactEdgeAuthorityValue,
} from "./integratedLocalStore.js";
import { edgeError } from "./errors.js";
import type { EdgeTelemetry } from "./observability.js";

export type IntegratedAuthServicesOptions = {
  readonly store: EdgeLocalAuthorityStore;
  readonly config: NormalizedEdgeControlPlaneConfig;
  readonly publicOrigin: string;
  readonly defaultTenantId?: string;
  readonly now?: () => number;
  readonly telemetry?: EdgeTelemetry;
  readonly random?: () => string;
  readonly onEnrolled?: (device: EdgeEnrolledDeviceAuthority, request: EdgeEnrollRequest) => void | Promise<void>;
  readonly onRevoked?: (device: EdgeEnrolledDeviceAuthority) => void | Promise<void>;
};

type AccessTokenRecord = {
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly deviceCodeHash: string;
  readonly edgeNodeId?: string;
  readonly expiresAt: number;
  readonly audience: "enrollment" | "gateway";
};

type RefreshTokenRecord = {
  readonly tokenHash: string;
  readonly tenantId: string;
  readonly subjectId: string;
  readonly deviceCodeHash: string;
  readonly edgeNodeId?: string;
  readonly expiresAt: number;
};

type RateBucket = {
  count: number;
  windowStartedAt: number;
};

/**
 * Local-mode composition of device authorization, tokens, approval, enrollment,
 * and revocation against the protected authority store.
 * @pk
 */
export class IntegratedEdgeAuthServices
  implements
    EdgeDeviceAuthorizationService,
    EdgeTokenIssuanceService,
    EdgeApprovalService,
    EdgeEnrollmentService
{
  private readonly now: () => number;
  private readonly random: () => string;
  private readonly accessTokens = new Map<string, AccessTokenRecord>();
  private readonly refreshTokens = new Map<string, RefreshTokenRecord>();
  private readonly usedNonces = new Map<string, number>();
  private readonly rateBuckets = new Map<string, RateBucket>();
  private readonly urls: ReturnType<typeof buildEdgeControlPlaneUrls>;

  constructor(private readonly options: IntegratedAuthServicesOptions) {
    this.now = options.now ?? Date.now;
    this.random = options.random ?? (() => randomBytes(32).toString("base64url"));
    this.urls = buildEdgeControlPlaneUrls(options.publicOrigin, options.config.basePath);
  }

  async begin(request: EdgeDeviceAuthorizeRequest): Promise<EdgeDeviceAuthorizeResponse> {
    this.assertRequestSize(request);
    this.consumeRateLimit(`authorize:${rateLimitIdentity(request.rateLimitKey)}`);
    await this.options.store.pruneAuthorizationSessions(this.now());
    const now = this.now();
    const deviceCode = this.random();
    const userCode = formatUserCode(this.random().slice(0, 8).toUpperCase());
    const session: EdgeAuthorizationSession = {
      tenantId: request.tenantId ?? this.options.defaultTenantId ?? "default",
      clientId: request.clientId,
      deviceCodeHash: hashSecret(deviceCode),
      userCodeHash: hashSecret(normalizeUserCode(userCode)),
      createdAt: now,
      expiresAt: now + this.options.config.authorizationCodeTtlSeconds * 1_000,
      intervalSeconds: this.options.config.pollIntervalSeconds,
      pollAttempts: 0,
      status: "pending",
      ...(request.metadata ? { metadata: Object.freeze({ ...request.metadata }) } : {}),
    };
    await this.options.store.putAuthorizationSession(session);
    this.emit("edge.authorization.created", {
      tenantId: session.tenantId,
      clientId: session.clientId,
      expiresAt: session.expiresAt,
    });
    return {
      deviceCode,
      userCode,
      verificationUri: this.urls.verificationUrl,
      verificationUriComplete: `${this.urls.verificationUrl}?user_code=${encodeURIComponent(userCode)}`,
      expiresIn: this.options.config.authorizationCodeTtlSeconds,
      interval: this.options.config.pollIntervalSeconds,
    };
  }

  async poll(request: EdgeDeviceTokenRequest): Promise<
    | { readonly status: "pending" | "slow-down"; readonly interval?: number }
    | { readonly status: "authorized"; readonly tokens: EdgeControlPlaneTokenResponse }
    | { readonly status: "denied" | "expired" }
  > {
    this.assertRequestSize(request);
    this.consumeRateLimit(`poll:${rateLimitIdentity(request.rateLimitKey)}`);
    await this.options.store.pruneAuthorizationSessions(this.now());
    const deviceCodeHash = hashSecret(request.deviceCode);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      // Consume-once path: only one concurrent poll can mint tokens for an approved session.
      const consumed = await this.options.store.consumeApprovedSession(deviceCodeHash, request.clientId);
      if (consumed) {
        const tokens = await this.issueForApprovedSession(consumed);
        return { status: "authorized", tokens };
      }

      const session = await this.options.store.getSessionByDeviceCodeHash(deviceCodeHash);
      if (!session || session.clientId !== request.clientId) {
        return { status: "expired" };
      }
      const now = this.now();
      if (session.expiresAt <= now || session.status === "expired") {
        await this.options.store.compareAndSwapAuthorizationSession(
          deviceCodeHash,
          ["pending", "approved", "expired"],
          (current) => ({ ...current, status: "expired" }),
        );
        return { status: "expired" };
      }
      if (session.status === "denied") {
        return { status: "denied" };
      }
      if (session.status === "consumed" || session.status === "approved") {
        // Lost the consume race to another poll, or already issued.
        return { status: "expired" };
      }

      const pollAttempts = session.pollAttempts + 1;
      if (pollAttempts > this.options.config.maxPollAttempts) {
        await this.options.store.compareAndSwapAuthorizationSession(
          deviceCodeHash,
          ["pending"],
          (current) => ({ ...current, pollAttempts, status: "expired" }),
        );
        return { status: "expired" };
      }

      // Status-aware CAS so a concurrent approve cannot be overwritten back to pending.
      const updated = await this.options.store.compareAndSwapAuthorizationSession(
        deviceCodeHash,
        ["pending"],
        (current) => ({ ...current, pollAttempts: current.pollAttempts + 1 }),
      );
      if (!updated) {
        continue;
      }
      const slowDown = updated.pollAttempts > 3 && updated.pollAttempts % 3 === 0;
      return slowDown
        ? { status: "slow-down", interval: updated.intervalSeconds + 5 }
        : { status: "pending", interval: updated.intervalSeconds };
    }
    return { status: "expired" };
  }

  async getPendingByUserCode(userCode: string): Promise<EdgeAuthorizationSession | undefined> {
    const session = await this.options.store.getSessionByUserCode(userCode);
    if (!session || session.status !== "pending" || session.expiresAt <= this.now()) {
      return undefined;
    }
    return session;
  }

  async approve(userCode: string, decision: EdgeDeviceApprovalDecision): Promise<EdgeAuthorizationSession> {
    if (!decision.subjectId?.trim() || !decision.tenantId?.trim() || !decision.actorId?.trim()) {
      throw edgeError("EDGE_PROTOCOL", "Approval decision requires tenantId, subjectId, and actorId.");
    }
    const session = await this.options.store.getSessionByUserCode(userCode);
    if (!session || session.status !== "pending" || session.expiresAt <= this.now()) {
      throw edgeError("EDGE_PROTOCOL", "No pending Edge authorization matches this user code.");
    }
    if (session.tenantId !== decision.tenantId) {
      throw edgeError("EDGE_PROTOCOL", "Approval tenant does not match the pending authorization.");
    }
    const approved = await this.options.store.compareAndSwapAuthorizationSession(
      session.deviceCodeHash,
      ["pending"],
      (current) => ({
        ...current,
        status: "approved",
        subjectId: decision.subjectId,
        actorId: decision.actorId,
        approvedAt: decision.approvedAt,
      }),
    );
    if (!approved) {
      throw edgeError("EDGE_PROTOCOL", "No pending Edge authorization matches this user code.");
    }
    this.emit("edge.authorization.approved", {
      tenantId: approved.tenantId,
      subjectId: approved.subjectId,
      actorId: approved.actorId,
    });
    return approved;
  }

  async deny(
    userCode: string,
    decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string },
  ): Promise<EdgeAuthorizationSession> {
    const session = await this.options.store.getSessionByUserCode(userCode);
    if (!session || session.status !== "pending" || session.expiresAt <= this.now()) {
      throw edgeError("EDGE_PROTOCOL", "No pending Edge authorization matches this user code.");
    }
    const denied = await this.options.store.compareAndSwapAuthorizationSession(
      session.deviceCodeHash,
      ["pending"],
      (current) => ({
        ...current,
        status: "denied",
        actorId: decision.actorId,
        ...(decision.subjectId ? { subjectId: decision.subjectId } : {}),
      }),
    );
    if (!denied) {
      throw edgeError("EDGE_PROTOCOL", "No pending Edge authorization matches this user code.");
    }
    this.emit("edge.authorization.denied", {
      tenantId: denied.tenantId,
      actorId: denied.actorId,
    });
    return denied;
  }

  async issueForApprovedSession(session: EdgeAuthorizationSession): Promise<EdgeControlPlaneTokenResponse> {
    if ((session.status !== "approved" && session.status !== "consumed") || !session.subjectId) {
      throw edgeError("EDGE_PROTOCOL", "Cannot issue Edge tokens for an unapproved session.");
    }
    return this.issueTokenSet({
      tenantId: session.tenantId,
      subjectId: session.subjectId,
      deviceCodeHash: session.deviceCodeHash,
      audience: "enrollment",
    });
  }

  async refresh(request: EdgeTokenRefreshRequest): Promise<EdgeControlPlaneTokenResponse> {
    this.assertRequestSize(request);
    this.consumeRateLimit(`refresh:${rateLimitIdentity(request.rateLimitKey)}`);
    const memory = this.refreshTokens.get(hashSecret(request.refreshToken));
    if (memory && memory.expiresAt > this.now()) {
      this.refreshTokens.delete(hashSecret(request.refreshToken));
      return this.issueTokenSet({
        tenantId: memory.tenantId,
        subjectId: memory.subjectId,
        deviceCodeHash: memory.deviceCodeHash,
        ...(memory.edgeNodeId ? { edgeNodeId: memory.edgeNodeId } : {}),
        audience: memory.edgeNodeId ? "gateway" : "enrollment",
      });
    }
    const consumed = await this.options.store.consumeRefreshCredential(request.refreshToken);
    if (!consumed) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.invalid_grant, "Refresh token is invalid or expired.");
    }
    return this.issueTokenSet({
      tenantId: consumed.tenantId,
      subjectId: consumed.subjectId,
      deviceCodeHash: hashSecret(`${consumed.tenantId}:${consumed.edgeNodeId}`),
      edgeNodeId: consumed.edgeNodeId,
      audience: "gateway",
    });
  }

  async revokeDeviceTokens(tenantId: string, edgeNodeId: string): Promise<void> {
    await this.options.store.revokeDevice(tenantId, edgeNodeId, this.now());
    for (const [token, record] of this.accessTokens) {
      if (record.tenantId === tenantId && record.edgeNodeId === edgeNodeId) {
        this.accessTokens.delete(token);
      }
    }
  }

  async inspectAccessToken(accessToken: string): Promise<{
    readonly tenantId: string;
    readonly subjectId: string;
    readonly deviceCodeHash: string;
    readonly expiresAt: number;
    readonly audience: "enrollment" | "gateway";
    readonly edgeNodeId?: string;
  } | undefined> {
    const record = this.accessTokens.get(hashSecret(accessToken));
    if (!record || record.expiresAt <= this.now()) {
      if (record) this.accessTokens.delete(hashSecret(accessToken));
      return undefined;
    }
    return {
      tenantId: record.tenantId,
      subjectId: record.subjectId,
      deviceCodeHash: record.deviceCodeHash,
      expiresAt: record.expiresAt,
      audience: record.audience,
      ...(record.edgeNodeId ? { edgeNodeId: record.edgeNodeId } : {}),
    };
  }

  async enroll(request: EdgeEnrollRequest): Promise<EdgeEnrollResponse> {
    this.assertRequestSize(request);
    this.consumeRateLimit(`enroll:${rateLimitIdentity(request.rateLimitKey ?? request.deviceCode.slice(0, 8))}`);

    const access = await this.inspectAccessToken(request.accessToken);
    if (!access || access.audience !== "enrollment") {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Enrollment access token is invalid.");
    }
    if (access.deviceCodeHash !== hashSecret(request.deviceCode)) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.invalid_grant, "Enrollment device code mismatch.");
    }

    const payload = `${request.deviceCode}.${request.nonce}`;
    if (!verifyDeviceProof(request.publicKey, payload, request.proof)) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Enrollment proof is invalid.");
    }
    // Record nonce only after successful verification so failures cannot burn proofs.
    this.rememberNonce(`enroll:${request.nonce}`);

    const edgeNodeId = this.random();
    const deviceCredential = this.random();
    const now = this.now();
    const authority: EdgeEnrolledDeviceAuthority = {
      tenantId: access.tenantId,
      edgeNodeId,
      subjectId: access.subjectId,
      publicKey: request.publicKey,
      credentialId: hashSecret(deviceCredential).slice(0, 24),
      credentialHash: hashSecret(deviceCredential),
      enrolledAt: now,
      revoked: false,
      connectionGeneration: 1,
      user: {
        name: request.name ?? request.hostnameLabel ?? `edge-${edgeNodeId.slice(0, 8)}`,
        ...(request.description ? { description: request.description } : {}),
        tags: Object.freeze([...(request.tags ?? [])]),
        updatedAt: now,
      },
      managed: { aliases: Object.freeze([]), pools: Object.freeze([]), updatedAt: now },
    };
    await this.options.store.putEnrolledDevice(authority);

    // Bind remaining refresh material to the enrolled device and drop the one-time access token.
    this.accessTokens.delete(hashSecret(request.accessToken));
    for (const [tokenHash, record] of this.refreshTokens) {
      if (record.deviceCodeHash === access.deviceCodeHash) {
        this.refreshTokens.delete(tokenHash);
        await this.options.store.putRefreshCredential({
          tenantId: access.tenantId,
          edgeNodeId,
          subjectId: access.subjectId,
          refreshTokenHash: tokenHash,
          expiresAt: record.expiresAt,
          rotatedAt: now,
        });
      }
    }

    try {
      await this.options.onEnrolled?.(authority, request);
    } catch (error) {
      // Roll back durable authority so a failed registry/side-effect cannot
      // leave a restart-blocking orphan after the client sees enrollment fail.
      await this.options.store.removeEnrolledDevice(access.tenantId, edgeNodeId);
      throw error;
    }

    this.emit("edge.enrollment.completed", {
      tenantId: access.tenantId,
      subjectId: access.subjectId,
      edgeNodeId,
    });

    return {
      edgeNodeId,
      tenantId: access.tenantId,
      gatewayUrl: this.urls.gatewayUrl,
      deviceCredential,
    };
  }

  async revoke(request: EdgeRevokeRequest, accessToken: string): Promise<void> {
    this.assertRequestSize(request);
    const access = await this.inspectAccessToken(accessToken);
    if (!access) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Revocation access token is invalid.");
    }
    // Enrollment tokens must not revoke arbitrary sibling devices for the same subject.
    if (access.audience !== "gateway" || access.edgeNodeId !== request.edgeNodeId) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Revocation was rejected.");
    }
    const device = await this.options.store.getEnrolledDevice(access.tenantId, request.edgeNodeId);
    if (!device || device.subjectId !== access.subjectId) {
      // Do not confirm existence to unauthorized callers.
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Revocation was rejected.");
    }
    await this.revokeDeviceTokens(access.tenantId, request.edgeNodeId);
    const revoked = await this.options.store.getEnrolledDevice(access.tenantId, request.edgeNodeId);
    if (revoked) await this.options.onRevoked?.(revoked);
    this.emit("edge.device.revoked", {
      tenantId: access.tenantId,
      edgeNodeId: request.edgeNodeId,
    });
  }

  async authenticateHello(proof: EdgeAuthenticatedHelloProof): Promise<EdgeAuthenticatedHelloResult> {
    this.assertRequestSize(proof);
    const device = await this.options.store.getEnrolledDevice(proof.tenantId, proof.edgeNodeId);
    if (!device || device.revoked) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized };
    }
    if (!compareSecretHash(device.credentialHash, proof.deviceCredential)) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized };
    }
    const payload = `${proof.edgeNodeId}.${proof.nonce}.edge.hello`;
    if (!verifyDeviceProof(device.publicKey, payload, proof.proof)) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized };
    }
    const protocolVersion = Math.max(...proof.protocolVersions.filter((version) => version === 1 || version === 2 || version === 3));
    if (!Number.isFinite(protocolVersion) || protocolVersion < 1) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.invalid_request };
    }
    // Persist hello nonce only after successful verification (restart-safe replay rejection).
    const acceptedNonce = await this.options.store.rememberHelloNonce(proof.nonce);
    if (!acceptedNonce) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized };
    }
    // Authority store remains the durable generation source; registry is synced by the runtime authenticator.
    const advanced = await this.options.store.advanceEnrolledConnectionGeneration(proof.tenantId, proof.edgeNodeId);
    if (!advanced) {
      return { status: "rejected", error: EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized };
    }
    return {
      status: "accepted",
      tenantId: advanced.tenantId,
      edgeNodeId: advanced.edgeNodeId,
      credentialId: advanced.credentialId,
      connectionGeneration: advanced.connectionGeneration,
      protocolVersion,
    };
  }

  confidentialErrorBody(code: keyof typeof EDGE_CONTROL_PLANE_ERROR_CODES, description?: string) {
    return edgeControlPlaneError(EDGE_CONTROL_PLANE_ERROR_CODES[code], description);
  }

  private async issueTokenSet(input: {
    readonly tenantId: string;
    readonly subjectId: string;
    readonly deviceCodeHash: string;
    readonly edgeNodeId?: string;
    readonly audience: "enrollment" | "gateway";
  }): Promise<EdgeControlPlaneTokenResponse> {
    const now = this.now();
    const accessToken = this.random();
    const refreshToken = this.random();
    const expiresAt = now + this.options.config.accessTokenTtlSeconds * 1_000;
    const refreshExpiresAt = now + this.options.config.refreshTokenTtlSeconds * 1_000;
    this.accessTokens.set(hashSecret(accessToken), {
      tokenHash: hashSecret(accessToken),
      tenantId: input.tenantId,
      subjectId: input.subjectId,
      deviceCodeHash: input.deviceCodeHash,
      ...(input.edgeNodeId ? { edgeNodeId: input.edgeNodeId } : {}),
      expiresAt,
      audience: input.audience,
    });
    if (input.edgeNodeId) {
      await this.options.store.putRefreshCredential({
        tenantId: input.tenantId,
        edgeNodeId: input.edgeNodeId,
        subjectId: input.subjectId,
        refreshTokenHash: hashSecret(refreshToken),
        expiresAt: refreshExpiresAt,
        rotatedAt: now,
      });
    } else {
      this.refreshTokens.set(hashSecret(refreshToken), {
        tokenHash: hashSecret(refreshToken),
        tenantId: input.tenantId,
        subjectId: input.subjectId,
        deviceCodeHash: input.deviceCodeHash,
        expiresAt: refreshExpiresAt,
      });
    }
    return {
      accessToken,
      refreshToken,
      expiresAt,
      tokenType: "Bearer",
    };
  }

  private assertRequestSize(value: unknown): void {
    const size = Buffer.byteLength(JSON.stringify(value), "utf8");
    if (size > this.options.config.maxRequestBytes) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.payload_too_large, "Request exceeds configured size limit.");
    }
  }

  private consumeRateLimit(key: string): void {
    const now = this.now();
    const bucket = this.rateBuckets.get(key);
    if (!bucket || now - bucket.windowStartedAt >= 60_000) {
      this.rateBuckets.set(key, { count: 1, windowStartedAt: now });
      return;
    }
    bucket.count += 1;
    if (bucket.count > this.options.config.rateLimitPerMinute) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.rate_limited, "Request rate limit exceeded.");
    }
  }

  private rememberNonce(nonce: string): void {
    const now = this.now();
    for (const [value, seenAt] of this.usedNonces) {
      if (now - seenAt > 10 * 60_000) {
        this.usedNonces.delete(value);
      }
    }
    if (this.usedNonces.has(nonce)) {
      throw confidentialError(EDGE_CONTROL_PLANE_ERROR_CODES.unauthorized, "Replay detected.");
    }
    this.usedNonces.set(nonce, now);
  }

  private emit(name: "edge.authorization.created" | "edge.authorization.approved" | "edge.authorization.denied" | "edge.enrollment.completed" | "edge.device.revoked", data: Record<string, unknown>): void {
    void this.options.telemetry?.emit({
      name,
      tenantId: typeof data.tenantId === "string" ? data.tenantId : undefined,
      subjectId: typeof data.subjectId === "string" ? data.subjectId : undefined,
      edgeNodeId: typeof data.edgeNodeId === "string" ? data.edgeNodeId : undefined,
      metadata: redactEdgeAuthorityValue(data) as Record<string, unknown>,
    });
  }
}

function formatUserCode(raw: string): string {
  const normalized = normalizeUserCode(raw).padEnd(8, "X").slice(0, 8);
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

function verifyDeviceProof(publicKeyPem: string, payload: string, proof: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return verify(null, Buffer.from(payload), key, Buffer.from(proof, "base64url"));
  } catch {
    return false;
  }
}

function confidentialError(code: string, message: string): Error {
  const error = edgeError("EDGE_PROTOCOL", message);
  (error as Error & { controlPlaneCode?: string }).controlPlaneCode = code;
  return error;
}

function rateLimitIdentity(key: string | undefined): string {
  const trimmed = key?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : "unknown";
}

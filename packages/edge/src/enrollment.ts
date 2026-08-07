import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import type { EdgeLocalConfig, EdgePlatform, StoredDeviceKeyPair } from "./platform.js";
import type { EdgeConnectionRuntime } from "./runtime.js";
import type { EdgeObservedFacts } from "@fentaris/core";

export interface DeviceAuthorizationRequest {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete?: string;
  readonly expiresIn: number;
  readonly interval: number;
}

export interface EdgeAuthorizationTokens {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}

export type DeviceAuthorizationPollResult =
  | { readonly status: "pending" | "slow-down" }
  | { readonly status: "authorized"; readonly tokens: EdgeAuthorizationTokens }
  | { readonly status: "denied" | "expired" };

export interface DeviceAuthorizationProvider {
  begin(): Promise<DeviceAuthorizationRequest>;
  poll(deviceCode: string): Promise<DeviceAuthorizationPollResult>;
  refresh(refreshToken: string): Promise<EdgeAuthorizationTokens>;
}

export interface EdgeEnrollmentRequest {
  readonly accessToken: string;
  readonly publicKey: string;
  readonly deviceCode: string;
  readonly nonce: string;
  readonly proof: string;
  readonly hostnameLabel?: string;
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

export interface EdgeEnrollmentResult {
  readonly edgeNodeId: string;
  readonly tenantId: string;
  readonly gatewayUrl: string;
  readonly deviceCredential: string;
}

export interface EdgeEnrollmentClient {
  enroll(request: EdgeEnrollmentRequest): Promise<EdgeEnrollmentResult>;
  revoke(edgeNodeId: string, accessToken: string): Promise<void>;
}

export interface EdgeConnection {
  readonly connectedAt: number;
  readonly closed?: Promise<void>;
  close(): Promise<void>;
}

export interface EdgeConnectionClient {
  connect(input: {
    gatewayUrl: string;
    edgeNodeId: string;
    tenantId: string;
    deviceCredential: string;
    accessToken: string;
    publicKey: string;
    privateKey: string;
    runtime?: EdgeConnectionRuntime;
    observedFacts?: EdgeObservedFacts;
  }): Promise<EdgeConnection>;
}

export interface EnrollmentCallbacks {
  onVerification(request: DeviceAuthorizationRequest): void | Promise<void>;
}

export interface EdgeEnrollmentServiceOptions {
  platform: EdgePlatform;
  authorization: DeviceAuthorizationProvider;
  enrollment: EdgeEnrollmentClient;
  callbacks: EnrollmentCallbacks;
  controlPlaneUrl?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  hostnameLabel?: () => string | undefined;
}

export interface EdgeLoginResult {
  readonly config: EdgeLocalConfig;
  readonly authorization: DeviceAuthorizationRequest;
  readonly repeated: boolean;
}

export interface EdgeJoinMetadata {
  readonly name?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
}

const ACCESS_TOKEN = "access-token";
const REFRESH_TOKEN = "refresh-token";
const ACCESS_EXPIRES_AT = "access-expires-at";
const DEVICE_CREDENTIAL = "device-credential";

/** Device-authorization enrollment with random key creation and proof-of-possession. */
export class EdgeEnrollmentService {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly options: EdgeEnrollmentServiceOptions) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async login(metadata: EdgeJoinMetadata = {}): Promise<EdgeLoginResult> {
    const existing = await this.options.platform.configStore.load();
    if (existing && await this.options.platform.credentialStore.get(DEVICE_CREDENTIAL)) {
      await this.validAccessToken();
      const config = this.options.controlPlaneUrl && existing.controlPlaneUrl !== this.options.controlPlaneUrl
        ? { ...existing, controlPlaneUrl: this.options.controlPlaneUrl }
        : existing;
      if (config !== existing) await this.options.platform.configStore.save(config);
      return {
        config,
        authorization: {
          deviceCode: "",
          userCode: "",
          verificationUri: "",
          expiresIn: 0,
          interval: 0,
        },
        repeated: true,
      };
    }

    const keyPair = await this.loadOrCreateKeyPair();
    const authorization = await this.options.authorization.begin();
    await this.options.callbacks.onVerification(authorization);
    const tokens = await this.awaitAuthorization(authorization);
    const nonce = randomBytes(32).toString("base64url");
    const proof = sign(
      null,
      Buffer.from(`${authorization.deviceCode}.${nonce}`),
      keyPair.privateKey,
    ).toString("base64url");
    const enrolled = await this.options.enrollment.enroll({
      accessToken: tokens.accessToken,
      publicKey: keyPair.publicKey,
      deviceCode: authorization.deviceCode,
      nonce,
      proof,
      hostnameLabel: this.options.hostnameLabel?.(),
      ...metadata,
    });
    const config: EdgeLocalConfig = {
      edgeNodeId: enrolled.edgeNodeId,
      tenantId: enrolled.tenantId,
      ...(this.options.controlPlaneUrl ? { controlPlaneUrl: this.options.controlPlaneUrl } : {}),
      gatewayUrl: enrolled.gatewayUrl,
      enrolledAt: this.now(),
      hostnameLabel: this.options.hostnameLabel?.(),
    };
    await this.options.platform.configStore.save(config);
    await this.saveTokens(tokens);
    await this.options.platform.credentialStore.set(DEVICE_CREDENTIAL, enrolled.deviceCredential);
    return { config, authorization, repeated: false };
  }

  async validAccessToken(): Promise<string> {
    const accessToken = await this.options.platform.credentialStore.get(ACCESS_TOKEN);
    const expiresAt = Number(await this.options.platform.credentialStore.get(ACCESS_EXPIRES_AT));
    if (accessToken && Number.isFinite(expiresAt) && expiresAt > this.now() + 30_000) {
      return accessToken;
    }
    const refreshToken = await this.options.platform.credentialStore.get(REFRESH_TOKEN);
    if (!refreshToken) throw new Error("Edge authorization is missing; run fentaris-edge login");
    const refreshed = await this.options.authorization.refresh(refreshToken);
    await this.saveTokens(refreshed);
    return refreshed.accessToken;
  }

  async connectionCredentials() {
    const config = await this.options.platform.configStore.load();
    const keyPair = await this.options.platform.deviceKeyStore.load();
    const deviceCredential = await this.options.platform.credentialStore.get(DEVICE_CREDENTIAL);
    if (!config || !keyPair || !deviceCredential) {
      throw new Error("Edge device is not enrolled; run fentaris-edge login");
    }
    return {
      config,
      keyPair,
      deviceCredential,
      accessToken: await this.validAccessToken(),
    };
  }

  async revokeRemote(): Promise<void> {
    const config = await this.options.platform.configStore.load();
    if (!config) return;
    await this.options.enrollment.revoke(config.edgeNodeId, await this.validAccessToken());
  }

  async clearLocalIdentity(): Promise<void> {
    await Promise.all([
      this.options.platform.configStore.delete(),
      this.options.platform.deviceKeyStore.delete(),
      this.options.platform.credentialStore.delete(ACCESS_TOKEN),
      this.options.platform.credentialStore.delete(REFRESH_TOKEN),
      this.options.platform.credentialStore.delete(ACCESS_EXPIRES_AT),
      this.options.platform.credentialStore.delete(DEVICE_CREDENTIAL),
    ]);
  }

  private async loadOrCreateKeyPair(): Promise<StoredDeviceKeyPair> {
    const existing = await this.options.platform.deviceKeyStore.load();
    if (existing) return existing;
    const generated = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const keyPair: StoredDeviceKeyPair = {
      publicKey: generated.publicKey,
      privateKey: generated.privateKey,
      createdAt: this.now(),
    };
    await this.options.platform.deviceKeyStore.save(keyPair);
    return keyPair;
  }

  private async awaitAuthorization(request: DeviceAuthorizationRequest): Promise<EdgeAuthorizationTokens> {
    const expiresAt = this.now() + request.expiresIn * 1_000;
    let interval = Math.max(1, request.interval) * 1_000;
    while (this.now() < expiresAt) {
      const result = await this.options.authorization.poll(request.deviceCode);
      if (result.status === "authorized") return result.tokens;
      if (result.status === "denied") throw new Error("Device authorization was denied");
      if (result.status === "expired") break;
      if (result.status === "slow-down") interval += 5_000;
      await this.sleep(interval);
    }
    throw new Error("Device authorization expired");
  }

  private async saveTokens(tokens: EdgeAuthorizationTokens): Promise<void> {
    await Promise.all([
      this.options.platform.credentialStore.set(ACCESS_TOKEN, tokens.accessToken),
      this.options.platform.credentialStore.set(REFRESH_TOKEN, tokens.refreshToken),
      this.options.platform.credentialStore.set(ACCESS_EXPIRES_AT, String(tokens.expiresAt)),
    ]);
  }
}

/** HTTP device authorization provider for self-hosted or managed control planes. */
export class HttpDeviceAuthorizationProvider implements DeviceAuthorizationProvider {
  constructor(private readonly baseUrl: string, private readonly clientId = "fentaris-edge") {}
  async begin(): Promise<DeviceAuthorizationRequest> {
    return postJson(`${this.baseUrl}/device/authorize`, { clientId: this.clientId });
  }
  async poll(deviceCode: string): Promise<DeviceAuthorizationPollResult> {
    const response = await fetch(`${this.baseUrl}/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId: this.clientId, deviceCode }),
    });
    const body = await response.json() as Record<string, unknown>;
    if (response.ok) {
      return { status: "authorized", tokens: body as unknown as EdgeAuthorizationTokens };
    }
    if (body.error === "authorization_pending") return { status: "pending" };
    if (body.error === "slow_down") return { status: "slow-down" };
    if (body.error === "access_denied") return { status: "denied" };
    if (body.error === "expired_token") return { status: "expired" };
    throw new Error(`Edge control-plane request failed with HTTP ${response.status}`);
  }
  async refresh(refreshToken: string): Promise<EdgeAuthorizationTokens> {
    return postJson(`${this.baseUrl}/token/refresh`, { clientId: this.clientId, refreshToken });
  }
}

/** HTTP enrollment client. Sensitive authorization fields are never included in errors. */
export class HttpEdgeEnrollmentClient implements EdgeEnrollmentClient {
  constructor(private readonly baseUrl: string) {}
  async enroll(request: EdgeEnrollmentRequest): Promise<EdgeEnrollmentResult> {
    return postJson(`${this.baseUrl}/edge/enroll`, request, request.accessToken);
  }
  async revoke(edgeNodeId: string, accessToken: string): Promise<void> {
    await postJson(`${this.baseUrl}/edge/revoke`, { edgeNodeId }, accessToken);
  }
}

async function postJson<T>(url: string, body: unknown, bearer?: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Edge control-plane request failed with HTTP ${response.status}`);
  return response.json() as Promise<T>;
}

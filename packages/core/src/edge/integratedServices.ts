/**
 * Internal service interfaces for the integrated Edge control plane.
 * Implementations live behind these replaceable boundaries so local and managed
 * modes share one runtime composition.
 * @pk
 */

import type { EdgeDeviceApprovalDecision } from "./integratedConfig.js";
import type {
  EdgeAuthenticatedHelloProof,
  EdgeAuthenticatedHelloResult,
  EdgeControlPlaneTokenResponse,
  EdgeDeviceAuthorizeRequest,
  EdgeDeviceAuthorizeResponse,
  EdgeDeviceTokenRequest,
  EdgeEnrollRequest,
  EdgeEnrollResponse,
  EdgeRevokeRequest,
  EdgeTokenRefreshRequest,
} from "./integratedProtocol.js";

/** Durable authorization-session record used by device-code flows. @pk */
export type EdgeAuthorizationSession = {
  readonly tenantId: string;
  readonly clientId: string;
  readonly deviceCodeHash: string;
  /** SHA-256 hash of the normalized user code; plaintext codes are never stored. @pk */
  readonly userCodeHash: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly pollAttempts: number;
  readonly status: "pending" | "approved" | "denied" | "consumed" | "expired";
  readonly subjectId?: string;
  readonly actorId?: string;
  readonly approvedAt?: number;
  readonly metadata?: Readonly<Record<string, string>>;
};

/** Enrolled device authority used for gateway authentication. @pk */
export type EdgeEnrolledDeviceAuthority = {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly subjectId: string;
  readonly publicKey: string;
  readonly credentialId: string;
  readonly credentialHash: string;
  readonly enrolledAt: number;
  readonly revoked: boolean;
  readonly revokedAt?: number;
  readonly connectionGeneration: number;
};

/** Device authorization domain service. @pk */
export interface EdgeDeviceAuthorizationService {
  begin(request: EdgeDeviceAuthorizeRequest): Promise<EdgeDeviceAuthorizeResponse>;
  poll(request: EdgeDeviceTokenRequest): Promise<
    | { readonly status: "pending" | "slow-down"; readonly interval?: number }
    | { readonly status: "authorized"; readonly tokens: EdgeControlPlaneTokenResponse }
    | { readonly status: "denied" | "expired" }
  >;
  getPendingByUserCode(userCode: string): Promise<EdgeAuthorizationSession | undefined>;
}

/** Token issuance and refresh rotation. @pk */
export interface EdgeTokenIssuanceService {
  issueForApprovedSession(session: EdgeAuthorizationSession): Promise<EdgeControlPlaneTokenResponse>;
  refresh(request: EdgeTokenRefreshRequest): Promise<EdgeControlPlaneTokenResponse>;
  revokeDeviceTokens(tenantId: string, edgeNodeId: string): Promise<void>;
  inspectAccessToken(accessToken: string): Promise<{
    readonly tenantId: string;
    readonly subjectId: string;
    readonly deviceCodeHash: string;
    readonly expiresAt: number;
    readonly audience: "enrollment" | "gateway";
    readonly edgeNodeId?: string;
  } | undefined>;
}

/** Operator approval service. @pk */
export interface EdgeApprovalService {
  approve(userCode: string, decision: EdgeDeviceApprovalDecision): Promise<EdgeAuthorizationSession>;
  deny(userCode: string, decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string }): Promise<EdgeAuthorizationSession>;
}

/** Enrolled-device storage and lookup for gateway authentication. @pk */
export interface EdgeEnrolledDeviceStore {
  get(tenantId: string, edgeNodeId: string): Promise<EdgeEnrolledDeviceAuthority | undefined>;
  put(device: EdgeEnrolledDeviceAuthority): Promise<void>;
  revoke(tenantId: string, edgeNodeId: string, revokedAt: number): Promise<EdgeEnrolledDeviceAuthority | undefined>;
}

/** Enrollment domain service. @pk */
export interface EdgeEnrollmentService {
  enroll(request: EdgeEnrollRequest): Promise<EdgeEnrollResponse>;
  revoke(request: EdgeRevokeRequest, accessToken: string): Promise<void>;
  authenticateHello(proof: EdgeAuthenticatedHelloProof): Promise<EdgeAuthenticatedHelloResult>;
}

/** Desired-state assignment snapshot for one device. @pk */
export type EdgeDesiredAssignmentSnapshot = {
  readonly tenantId: string;
  readonly edgeNodeId: string;
  readonly version: number;
  readonly digest: string;
  readonly deploymentIds: readonly string[];
  readonly updatedAt: number;
};

/** Desired-state assignment store with compare-and-swap semantics. @pk */
export interface EdgeDesiredAssignmentStore {
  get(tenantId: string, edgeNodeId: string): Promise<EdgeDesiredAssignmentSnapshot | undefined>;
  compareAndSwap(
    snapshot: EdgeDesiredAssignmentSnapshot,
    expectedVersion: number | undefined,
  ): Promise<"updated" | "unchanged" | "conflict">;
  remove(tenantId: string, edgeNodeId: string): Promise<void>;
}

/** Triggers that enqueue per-device reconciliation. @pk */
export type EdgeReconciliationTrigger =
  | "application-start"
  | "enrollment"
  | "connection"
  | "inventory-change"
  | "readiness-change"
  | "grant-update"
  | "assignment-update"
  | "revocation";

/** Reconciliation scheduler / trigger surface. @pk */
export interface EdgeReconciliationTriggerService {
  enqueue(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<void>;
  reconcileNow(input: {
    readonly tenantId: string;
    readonly edgeNodeId: string;
    readonly trigger: EdgeReconciliationTrigger;
  }): Promise<EdgeDesiredAssignmentSnapshot | undefined>;
}

/** Protected local operator channel used by CLI approval commands. @pk */
export interface EdgeLocalOperatorChannel {
  approve(userCode: string, decision: EdgeDeviceApprovalDecision): Promise<EdgeAuthorizationSession>;
  deny(userCode: string, decision: Omit<EdgeDeviceApprovalDecision, "subjectId"> & { readonly subjectId?: string }): Promise<EdgeAuthorizationSession>;
  status(): Promise<{
    readonly mode: "local";
    readonly multiInstance: false;
    readonly pendingApprovals: number;
    readonly enrolledDevices: number;
  }>;
  close(): Promise<void>;
}

import type {
  EdgeCapabilityManifestMessage,
  EdgeDesiredStateAckMessage,
  EdgeInstallationStatusMessage,
  EdgePresenceReportMessage,
  EdgeSetupStatusMessage,
} from "./controlProtocol.js";
import type {
  EdgeCapabilityManifestStore,
  EdgeConnectionRecord,
  EdgeDesiredStateStore,
  EdgeDeviceRegistry,
  EdgeInstallationStatusStore,
  EdgeSetupStatusStore,
} from "./controlPlane.js";
import type { EdgeCapabilityCache } from "./capabilityCache.js";
import type { EdgeGatewayAuthorization, EdgeGatewayAuthorizer, EdgeGatewayEventSink } from "./gateway.js";
import type { EdgePresenceStore, EdgeReadinessStore } from "./inventory.js";
import type { IntegratedEdgeReconciler } from "./integratedReconciliation.js";
import type { EdgeTelemetry } from "./observability.js";

export type IntegratedEdgeBridgeOptions = {
  readonly devices: EdgeDeviceRegistry;
  readonly desired: EdgeDesiredStateStore;
  readonly setup: EdgeSetupStatusStore;
  readonly manifests: EdgeCapabilityManifestStore;
  readonly presence: EdgePresenceStore;
  readonly readiness: EdgeReadinessStore;
  readonly reconciler: IntegratedEdgeReconciler;
  readonly capabilityCache: EdgeCapabilityCache;
  readonly installation?: EdgeInstallationStatusStore;
  readonly telemetry?: EdgeTelemetry;
};

/** Bridges authenticated gateway state into reconciliation, discovery and dispatch. @pk */
export class IntegratedEdgeGatewayBridge implements EdgeGatewayEventSink, EdgeGatewayAuthorizer {
  constructor(private readonly options: IntegratedEdgeBridgeOptions) {}

  async connected(connection: EdgeConnectionRecord): Promise<void> {
    await this.options.reconciler.enqueue({
      tenantId: connection.tenantId,
      edgeNodeId: connection.edgeNodeId,
      trigger: "connection",
    });
    await this.setAssignedOnline(connection.tenantId, connection.edgeNodeId, true);
  }

  async disconnected(connection: EdgeConnectionRecord): Promise<void> {
    await this.setAssignedOnline(connection.tenantId, connection.edgeNodeId, false);
  }

  async desiredAcknowledged(message: EdgeDesiredStateAckMessage): Promise<void> {
    await this.options.reconciler.enqueue({
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      trigger: "readiness-change",
    });
  }

  async setupChanged(message: EdgeSetupStatusMessage): Promise<void> {
    await this.options.telemetry?.emit({
      name: "edge.setup.transition",
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      deploymentId: message.deploymentId,
      connectionGeneration: message.connectionGeneration,
      outcome: message.status,
      metadata: { setupSchemaVersion: message.setupSchemaVersion },
    });
    await this.options.reconciler.enqueue({
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      trigger: "readiness-change",
    });
  }

  async manifestChanged(message: EdgeCapabilityManifestMessage): Promise<void> {
    await this.options.capabilityCache.setDesiredRecipe(message.tenantId, message.deploymentId, message.recipeDigest);
    await this.options.capabilityCache.update({
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      connectionGeneration: message.connectionGeneration,
      deploymentId: message.deploymentId,
      recipeDigest: message.recipeDigest,
      capturedAt: Date.now(),
      tools: message.tools as never[],
      resources: message.resources as never[],
      resourceTemplates: message.resourceTemplates as never[],
      prompts: message.prompts as never[],
      supportsCompletion: message.supportsCompletion,
    });
  }

  async presenceChanged(message: EdgePresenceReportMessage): Promise<void> {
    const desired = await this.options.desired.get(message.tenantId, message.edgeNodeId);
    for (const deployment of desired?.deployments ?? []) {
      await this.options.capabilityCache.setOnline(message.tenantId, deployment.deploymentId, true);
    }
    await this.options.reconciler.enqueue({
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      trigger: "inventory-change",
    });
  }

  async installationChanged(message: EdgeInstallationStatusMessage): Promise<void> {
    await this.options.reconciler.enqueue({
      tenantId: message.tenantId,
      edgeNodeId: message.edgeNodeId,
      trigger: "readiness-change",
    });
  }

  async authorize(input: EdgeGatewayAuthorization): Promise<boolean> {
    if (input.message.kind !== "mcp.request" && input.message.kind !== "mcp.cancel") return true;
    const route = input.message.route;
    const device = await this.options.devices.get(input.identity.tenantId, input.identity.edgeNodeId);
    const desired = await this.options.desired.get(input.identity.tenantId, input.identity.edgeNodeId);
    const presence = await this.options.presence.get(input.identity.tenantId, input.identity.edgeNodeId);
    const deployment = desired?.deployments.find((candidate) => candidate.deploymentId === route.deploymentId);
    let allowed = Boolean(
      device
      && !device.revoked
      && input.connection.connectionGeneration === route.connectionGeneration
      && presence?.status === "online"
      && presence.heartbeat.fresh
      && presence.connectionGeneration === route.connectionGeneration
      && deployment,
    );
    if (allowed && input.message.kind === "mcp.request") {
      const readiness = await this.options.readiness.get(
        input.identity.tenantId,
        input.identity.edgeNodeId,
        route.deploymentId,
      );
      const manifest = await this.options.manifests.get(
        input.identity.tenantId,
        input.identity.edgeNodeId,
        route.deploymentId,
      );
      allowed = Boolean(
        readiness?.status === "ready"
        && readiness.connectionGeneration === route.connectionGeneration
        && readiness.desiredVersion === desired?.desiredVersion
        && (readiness.launchDigest === undefined || readiness.launchDigest === deployment?.recipe.digest)
        && manifest?.connectionGeneration === route.connectionGeneration
        && manifest.recipeDigest === deployment?.recipe.digest
        && supportsOperation(manifest, input.message.operation, input.message.params),
      );
    }
    await this.options.telemetry?.emit({
      name: "edge.dispatch.gated",
      tenantId: input.identity.tenantId,
      edgeNodeId: input.identity.edgeNodeId,
      connectionGeneration: route.connectionGeneration,
      deploymentId: route.deploymentId,
      subjectId: route.subjectId,
      requestId: input.message.requestId,
      outcome: allowed ? "allowed" : "denied",
    });
    return allowed;
  }

  private async setAssignedOnline(tenantId: string, edgeNodeId: string, online: boolean): Promise<void> {
    const desired = await this.options.desired.get(tenantId, edgeNodeId);
    for (const deployment of desired?.deployments ?? []) {
      await this.options.capabilityCache.setOnline(tenantId, deployment.deploymentId, online);
    }
  }
}

function supportsOperation(
  manifest: EdgeCapabilityManifestMessage,
  operation: string,
  params: unknown,
): boolean {
  if (operation === "tools/call") {
    const name = objectString(params, "name");
    return Boolean(name && manifest.tools.some((tool) => objectString(tool, "name") === name));
  }
  if (operation === "resources/read") {
    const uri = objectString(params, "uri");
    return Boolean(uri && (manifest.resources.some((resource) => objectString(resource, "uri") === uri)
      || manifest.resourceTemplates.length > 0));
  }
  if (operation === "prompts/get") {
    const name = objectString(params, "name");
    return Boolean(name && manifest.prompts.some((prompt) => objectString(prompt, "name") === name));
  }
  if (operation === "completion/complete") return manifest.supportsCompletion;
  return true;
}

function objectString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" ? field : undefined;
}

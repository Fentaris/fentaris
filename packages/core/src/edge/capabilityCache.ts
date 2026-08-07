import type {
  ListPromptsResult,
  ListResourcesResult,
  ListResourceTemplatesResult,
  ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";
import type { FentarisTransport } from "../types/transport.js";
import { edgeError } from "./errors.js";

export interface EdgeCapabilityManifest {
  readonly tenantId: string;
  readonly edgeNodeId?: string;
  readonly connectionGeneration?: number;
  readonly deploymentId: string;
  readonly recipeDigest: string;
  readonly capturedAt: number;
  readonly tools: ListToolsResult["tools"];
  readonly resources: ListResourcesResult["resources"];
  readonly resourceTemplates: ListResourceTemplatesResult["resourceTemplates"];
  readonly prompts: ListPromptsResult["prompts"];
  readonly supportsCompletion: boolean;
}

export interface EdgeCapabilityCacheStore {
  get(tenantId: string, deploymentId: string): Promise<EdgeCapabilityManifest | undefined>;
  put(manifest: EdgeCapabilityManifest): Promise<void>;
  delete(tenantId: string, deploymentId: string): Promise<void>;
}

export interface EdgeDiscoveryState {
  readonly status: "ready" | "offline-cached" | "setup-required";
  readonly diagnostic?: string;
  readonly cacheAgeMs?: number;
  readonly manifest?: EdgeCapabilityManifest;
}

export type EdgeCapabilityChangeListener = (
  tenantId: string,
  deploymentId: string,
  state: EdgeDiscoveryState,
) => void | Promise<void>;

export class InMemoryEdgeCapabilityCacheStore implements EdgeCapabilityCacheStore {
  private readonly manifests = new Map<string, EdgeCapabilityManifest>();
  async get(tenantId: string, deploymentId: string) {
    return this.manifests.get(cacheKey(tenantId, deploymentId));
  }
  async put(manifest: EdgeCapabilityManifest) {
    this.manifests.set(cacheKey(manifest.tenantId, manifest.deploymentId), freezeManifest(manifest));
  }
  async delete(tenantId: string, deploymentId: string) {
    this.manifests.delete(cacheKey(tenantId, deploymentId));
  }
}

/** Validated capability cache keyed by logical deployment, never public device identity. */
export class EdgeCapabilityCache {
  private readonly desiredRecipes = new Map<string, string>();
  /** Online Edge nodes contributing availability for a logical deployment. */
  private readonly onlineNodes = new Map<string, Set<string>>();
  private readonly listeners = new Set<EdgeCapabilityChangeListener>();

  constructor(
    readonly store: EdgeCapabilityCacheStore = new InMemoryEdgeCapabilityCacheStore(),
    private readonly now: () => number = Date.now,
  ) {}

  addListener(listener: EdgeCapabilityChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setDesiredRecipe(tenantId: string, deploymentId: string, recipeDigest: string): Promise<void> {
    const key = cacheKey(tenantId, deploymentId);
    const previous = this.desiredRecipes.get(key);
    this.desiredRecipes.set(key, recipeDigest);
    if (previous !== undefined && previous !== recipeDigest) {
      await this.store.delete(tenantId, deploymentId);
      this.onlineNodes.delete(key);
      await this.notify(tenantId, deploymentId);
    }
  }

  async update(manifest: EdgeCapabilityManifest): Promise<void> {
    validateManifest(manifest);
    const desired = this.desiredRecipes.get(cacheKey(manifest.tenantId, manifest.deploymentId));
    if (desired !== undefined && desired !== manifest.recipeDigest) {
      throw edgeError("EDGE_PROTOCOL", "Capability manifest recipe digest is stale.", {
        details: { deploymentId: manifest.deploymentId },
      });
    }
    await this.store.put(manifest);
    await this.notify(manifest.tenantId, manifest.deploymentId);
  }

  async setOnline(
    tenantId: string,
    deploymentId: string,
    online: boolean,
    edgeNodeId = "*",
  ): Promise<void> {
    const key = cacheKey(tenantId, deploymentId);
    const nodes = this.onlineNodes.get(key) ?? new Set<string>();
    if (online) {
      nodes.add(edgeNodeId);
    } else {
      nodes.delete(edgeNodeId);
      if (edgeNodeId === "*") {
        nodes.clear();
      }
    }
    if (nodes.size === 0) {
      this.onlineNodes.delete(key);
    } else {
      this.onlineNodes.set(key, nodes);
    }
    await this.notify(tenantId, deploymentId);
  }

  async state(tenantId: string, deploymentId: string): Promise<EdgeDiscoveryState> {
    const manifest = await this.store.get(tenantId, deploymentId);
    if (!manifest) {
      return {
        status: "setup-required",
        diagnostic: `Edge deployment "${deploymentId}" has no validated capability manifest; complete setup and start it once.`,
      };
    }
    const cacheAgeMs = Math.max(0, this.now() - manifest.capturedAt);
    const online = (this.onlineNodes.get(cacheKey(tenantId, deploymentId))?.size ?? 0) > 0;
    // Unset/false online must not advertise ready discovery.
    if (!online) {
      return {
        status: "offline-cached",
        diagnostic: `Edge deployment "${deploymentId}" is offline; discovery is using its last validated manifest.`,
        cacheAgeMs,
        manifest,
      };
    }
    return { status: "ready", cacheAgeMs, manifest };
  }

  /** Read-only transport facade consumed by proxy list operations. */
  discoveryTransport(tenantId: string, deploymentId: string): FentarisTransport {
    const manifest = async () => (await this.state(tenantId, deploymentId)).manifest;
    return {
      listTools: async () => ({ tools: (await manifest())?.tools ?? [] }),
      callTool: async () => {
        throw edgeError("EDGE_PROTOCOL", "Capability cache cannot execute MCP operations.");
      },
      listResources: async () => ({ resources: (await manifest())?.resources ?? [] }),
      listResourceTemplates: async () => ({ resourceTemplates: (await manifest())?.resourceTemplates ?? [] }),
      listPrompts: async () => ({ prompts: (await manifest())?.prompts ?? [] }),
      close: async () => undefined,
    };
  }

  private async notify(tenantId: string, deploymentId: string): Promise<void> {
    const state = await this.state(tenantId, deploymentId);
    await Promise.all([...this.listeners].map((listener) => listener(tenantId, deploymentId, state)));
  }
}

function validateManifest(manifest: EdgeCapabilityManifest): void {
  if (!manifest.tenantId || !manifest.deploymentId || !manifest.recipeDigest || !Number.isFinite(manifest.capturedAt)) {
    throw edgeError("EDGE_PROTOCOL", "Capability manifest identity/version fields are malformed.");
  }
  for (const [name, value] of Object.entries({
    tools: manifest.tools,
    resources: manifest.resources,
    resourceTemplates: manifest.resourceTemplates,
    prompts: manifest.prompts,
  })) {
    if (!Array.isArray(value)) throw edgeError("EDGE_PROTOCOL", `Capability manifest ${name} is malformed.`);
  }
  if (manifest.tools.some((tool) => !tool || typeof tool.name !== "string")) {
    throw edgeError("EDGE_PROTOCOL", "Capability manifest contains an invalid tool.");
  }
  if (manifest.prompts.some((prompt) => !prompt || typeof prompt.name !== "string")) {
    throw edgeError("EDGE_PROTOCOL", "Capability manifest contains an invalid prompt.");
  }
}

function freezeManifest(manifest: EdgeCapabilityManifest): EdgeCapabilityManifest {
  return Object.freeze({
    ...manifest,
    tools: [...manifest.tools],
    resources: [...manifest.resources],
    resourceTemplates: [...manifest.resourceTemplates],
    prompts: [...manifest.prompts],
  });
}

function cacheKey(tenantId: string, deploymentId: string): string {
  return `${tenantId}\u0000${deploymentId}`;
}

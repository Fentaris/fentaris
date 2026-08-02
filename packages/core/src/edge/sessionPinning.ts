/**
 * Session-target pinning.
 *
 * Combines placement resolution, device selection, and the session-binding
 * store to lazily pin a downstream session to one eligible edge device per
 * logical target before the first edge-dependent operation, and reuse that
 * pinning across every MCP declaration using the same logical target within
 * the same downstream session. The pin is removed on session end, expiry, or
 * runtime shutdown.
 *
 * Fentaris never silently fails over to another device: a binding is only
 * created once, and a takeover attempt by a different edge node is rejected
 * with `EDGE_UNAVAILABLE`. The same enrolled node may advance its connection
 * generation on reconnect.
 * @pk
 */

import { edgeError, type EdgeError } from "./errors.js";
import {
  PlacementResolver,
  requireDevice,
  type DeviceResolution,
  type DeviceResolver,
  type DeviceResolverContext,
  type PlacementRequest,
  type PlacementResolution,
  type PlacementResolverInputs,
} from "./placement.js";
import type { EdgeExecutionTarget, ExecutionTarget, TargetSelectionStrategy } from "./target.js";
import type { EdgeSessionSelectionStore } from "./inventory.js";
import type { EdgeSelectionRequest } from "./inventoryService.js";
import {
  InMemorySessionBindingStore,
  type ConnectionGeneration,
  type SessionBindingKey,
  type SessionBindingListener,
  type SessionBindingRemovalReason,
  type SessionBindingStore,
  type SessionBindingExpiryOptions,
  type SessionTargetBinding,
} from "./sessionBinding.js";

/** A request to pin (or reuse) a session target for one server. @pk */
export interface SessionPinRequest extends PlacementRequest {
  /** Downstream MCP session id. @pk */
  readonly sessionId: string;
  /** Connection generation of the candidate edge node (when known). @pk */
  readonly connectionGeneration?: ConnectionGeneration;
  /** Device id requested during downstream session establishment, if any. @pk */
  readonly requestedDeviceId?: string;
  /** Tenant id, when known. @pk */
  readonly tenantId?: string;
  /** Optional one-shot declarative device constraints for the first pin. @pk */
  readonly deviceSelection?: EdgeSelectionRequest;
}

/** The result of pinning a session target. @pk */
export type SessionPinResult =
  | { readonly kind: "cloud"; readonly targetName: "cloud"; readonly placement: PlacementResolution }
  | {
      readonly kind: "edge";
      readonly targetName: string;
      readonly placement: PlacementResolution;
      readonly device: DeviceResolution;
      readonly binding: SessionTargetBinding;
      readonly reused: boolean;
    };

/** Inputs for constructing an {@link EdgeSessionPinner}. @pk */
export interface EdgeSessionPinnerInputs extends PlacementResolverInputs {
  /** Control-plane device resolver. Required for edge targets. @pk */
  readonly deviceResolver: DeviceResolver;
  /** Replaceable binding store; defaults to {@link InMemorySessionBindingStore}. @pk */
  readonly store?: SessionBindingStore;
  /** Binding expiry configuration for the default in-memory store. @pk */
  readonly expiry?: SessionBindingExpiryOptions;
  /** Durable pre-pin selections, when agent-native selection is enabled. @pk */
  readonly selectionStore?: EdgeSessionSelectionStore;
}

/**
 * Lazily pins downstream sessions to edge devices and reuses pins across
 * MCP declarations that share a logical target in the same session.
 * @pk
 */
export class EdgeSessionPinner {
  private readonly resolver: PlacementResolver;
  private readonly deviceResolver: DeviceResolver;
  private readonly targets: ReadonlyMap<string, ExecutionTarget>;
  readonly store: SessionBindingStore;
  private readonly selectionStore?: EdgeSessionSelectionStore;

  constructor(inputs: EdgeSessionPinnerInputs) {
    this.targets = inputs.targets;
    this.resolver = new PlacementResolver({
      targets: inputs.targets,
      bindings: inputs.bindings,
    });
    this.deviceResolver = inputs.deviceResolver;
    this.store = inputs.store ?? new InMemorySessionBindingStore(inputs.expiry);
    this.selectionStore = inputs.selectionStore;
  }

  /** Register a removal listener (see {@link SessionBindingStore.addListener}). @pk */
  addListener(listener: SessionBindingListener): void {
    this.store.addListener(listener);
  }

  /**
   * Lazily resolve and pin `{ session, subject, target }` to one eligible edge
   * node before the first edge-dependent operation, reusing an existing pin
   * for the same logical target within the same downstream session.
   *
   * @throws {EdgeError} `EDGE_UNAUTHORIZED_TARGET` for an ineligible explicit
   *   session selection.
   * @throws {EdgeError} `EDGE_PLACEMENT_AMBIGUOUS` for unresolved runtime group
   *   overlap.
   * @throws {EdgeError} `EDGE_UNAVAILABLE` when no eligible device exists or a
   *   different edge node attempts to take over an existing pin.
   * @pk
   */
  async pin(request: SessionPinRequest): Promise<SessionPinResult> {
    const placement = this.resolver.resolve(request);
    if (placement.kind !== "edge") {
      return { kind: "cloud", targetName: "cloud", placement };
    }

    const target = this.resolverTarget(placement.targetName);
    if (!target || target.kind !== "edge") {
      throw edgeError("EDGE_UNAVAILABLE", "Resolved edge target is no longer registered.", {
        details: { targetName: placement.targetName },
      });
    }

    const key: SessionBindingKey = {
      sessionId: request.sessionId,
      subjectId: request.subjectId,
      targetName: placement.targetName,
    };

    const existing = await this.store.get(key);
    if (existing) {
      return {
        kind: "edge",
        targetName: placement.targetName,
        placement,
        device: { edgeNodeId: existing.edgeNodeId, alias: existing.alias },
        binding: existing,
        reused: true,
      };
    }

    const deviceContext: DeviceResolverContext = {
      subjectId: request.subjectId,
      tenantId: request.tenantId,
      targetName: placement.targetName,
      requestedDeviceId: request.requestedDeviceId,
      strategy: target.strategy,
      ...(request.deviceSelection ? { declarativeSelection: request.deviceSelection } : {}),
    };
    const selected = request.subjectId === undefined
      ? undefined
      : await this.selectionStore?.get(request.sessionId, request.subjectId, placement.targetName);
    let device: DeviceResolution;
    if (selected) {
      const resolved = await this.deviceResolver.resolveSelectedDevice?.(
        selected.edgeNodeId,
        selected.inventoryVersion,
        deviceContext,
      );
      if (!resolved) {
        throw edgeError("EDGE_UNAVAILABLE", "The selected Edge device is no longer eligible or available.", {
          details: { targetName: placement.targetName, nextActions: ["Discover and select an available device again."] },
        });
      }
      device = resolved;
    } else if (request.deviceSelection) {
      const resolved = await this.deviceResolver.resolveDeclarativeDevice?.(request.deviceSelection, deviceContext);
      if (!resolved) {
        throw edgeError("EDGE_UNAVAILABLE", "No eligible Edge device satisfies the requested requirements.", {
          details: { targetName: placement.targetName, nextActions: ["Relax the requirements or complete device setup."] },
        });
      }
      device = resolved;
    } else {
      device = await requireDevice(target.device, deviceContext, this.deviceResolver);
    }

    const binding = await this.store.store(key, {
      sessionId: request.sessionId,
      subjectId: request.subjectId,
      targetName: placement.targetName,
      edgeNodeId: device.edgeNodeId,
      alias: device.alias,
      connectionGeneration: request.connectionGeneration ?? 1,
    });

    return {
      kind: "edge",
      targetName: placement.targetName,
      placement,
      device,
      binding,
      reused: false,
    };
  }

  /**
   * Advance the connection generation for a pinned binding on reconnect by
   * the same enrolled node. Throws `EDGE_UNAVAILABLE` when a different node
   * attempts to resume the binding (silent takeover is rejected).
   * @pk
   */
  async reconnect(
    key: SessionBindingKey,
    edgeNodeId: string,
    connectionGeneration: ConnectionGeneration,
  ): Promise<SessionTargetBinding | undefined> {
    const existing = await this.store.get(key);
    if (!existing) {
      return undefined;
    }
    if (existing.edgeNodeId !== edgeNodeId) {
      throw edgeError("EDGE_UNAVAILABLE", "Another edge node attempted to resume a pinned session binding.", {
        details: { targetName: key.targetName },
      });
    }
    const refreshed = await this.store.store(key, {
      ...existing,
      connectionGeneration,
    });
    return refreshed;
  }

  /** Remove and return bindings for a session on downstream session end. @pk */
  async endSession(sessionId: string): Promise<readonly SessionTargetBinding[]> {
    const bindings = await this.store.deleteSession(sessionId);
    await this.selectionStore?.deleteSession(sessionId);
    return bindings;
  }

  /** Remove and return bindings for a target on target removal/shutdown. @pk */
  async removeTarget(targetName: string): Promise<readonly SessionTargetBinding[]> {
    return this.store.deleteTarget(targetName);
  }

  /** Remove expired bindings. @pk */
  async purgeExpired(): Promise<readonly SessionTargetBinding[]> {
    return this.store.purgeExpired();
  }

  /** Remove every binding on runtime shutdown. @pk */
  async shutdown(): Promise<readonly SessionTargetBinding[]> {
    return this.store.clear();
  }

  private resolverTarget(targetName: string): ExecutionTarget | undefined {
    return this.targets.get(targetName);
  }
}

export type {
  ConnectionGeneration,
  EdgeExecutionTarget,
  EdgeError,
  ExecutionTarget,
  SessionBindingKey,
  SessionBindingListener,
  SessionBindingRemovalReason,
  SessionBindingStore,
  SessionBindingExpiryOptions,
  SessionTargetBinding,
  TargetSelectionStrategy,
};
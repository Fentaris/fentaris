import {
  boolean as setupBoolean,
  file as setupFile,
  folder as setupFolder,
  number as setupNumber,
  secret as setupSecret,
  select as setupSelect,
  string as setupString,
} from "./setup.js";
import { install as edgeInstall } from "./installation.js";

/**
 * Reusable named execution targets and logical device selectors.
 *
 * An execution target describes *where* an MCP workload runs (cloud or edge)
 * independently from how the MCP is declared. Targets are logical resolvers,
 * not device identities: a selector resolves to an eligible enrolled device at
 * runtime through a control-plane resolver, never by hostname, IP, or hardware
 * fingerprint.
 * @pk
 */

/** Execution target kind. @pk */
export type TargetKind = "cloud" | "edge";

/** Strategy for selecting one device from a shared pool. @pk */
export type TargetSelectionStrategy = "least-loaded" | "random" | "round-robin" | "sticky";

/** Device selector discriminator. @pk */
export type DeviceSelectorType =
  | "session"
  | "user-default"
  | "named"
  | "pool"
  | "fallback";

/**
 * A serializable, composable device selector. Selector instances carry an `or`
 * method on the prototype (not serialized) but expose only data fields through
 * `JSON.stringify`, so they remain plain-data across the control-plane boundary.
 * @pk
 */
export interface DeviceSelector {
  readonly type: DeviceSelectorType;
  /** Alias for a `named` selector. @pk */
  readonly alias?: string;
  /** Pool name for a `pool` selector. @pk */
  readonly pool?: string;
  /** Selection strategy for a `pool` selector. @pk */
  readonly strategy?: TargetSelectionStrategy;
  /** Ordered selectors for a `fallback` selector; first eligible wins. @pk */
  readonly selectors?: readonly DeviceSelector[];
}

/**
 * Composable device selector builder. Own enumerable fields are serializable;
 * the {@link DeviceSelectorBuilder.or} method lives on the prototype and is
 * omitted by `JSON.stringify`.
 * @pk
 */
export class DeviceSelectorBuilder implements DeviceSelector {
  readonly type: DeviceSelectorType;
  readonly alias?: string;
  readonly pool?: string;
  readonly strategy?: TargetSelectionStrategy;
  readonly selectors?: readonly DeviceSelector[];

  private constructor(
    type: DeviceSelectorType,
    alias?: string,
    pool?: string,
    strategy?: TargetSelectionStrategy,
    selectors?: readonly DeviceSelector[],
  ) {
    this.type = type;
    if (alias !== undefined) this.alias = alias;
    if (pool !== undefined) this.pool = pool;
    if (strategy !== undefined) this.strategy = strategy;
    if (selectors !== undefined) this.selectors = selectors;
  }

  /** Select the device requested during downstream session establishment. @pk */
  static session(): DeviceSelectorBuilder {
    return new DeviceSelectorBuilder("session");
  }

  /** Select the subject's configured default device. @pk */
  static userDefault(): DeviceSelectorBuilder {
    return new DeviceSelectorBuilder("user-default");
  }

  /** Resolve a control-plane named alias to a device. @pk */
  static named(alias: string): DeviceSelectorBuilder {
    if (typeof alias !== "string" || alias.trim() === "") {
      throw new TypeError("namedDevice() requires a non-empty alias");
    }
    return new DeviceSelectorBuilder("named", alias);
  }

  /** Resolve one eligible device from a shared pool using `strategy`. @pk */
  static pool(name: string, strategy?: TargetSelectionStrategy): DeviceSelectorBuilder {
    if (typeof name !== "string" || name.trim() === "") {
      throw new TypeError("pool() requires a non-empty pool name");
    }
    return new DeviceSelectorBuilder("pool", undefined, name, strategy);
  }

  /** Compose a fallback: resolve `this` first, then `other` if not eligible. @pk */
  or(other: DeviceSelector): DeviceSelectorBuilder {
    return new DeviceSelectorBuilder("fallback", undefined, undefined, undefined, [this.toJSON(), coerceSelector(other)]);
  }

  /** Return a plain serializable selector object without prototype methods. @pk */
  toJSON(): DeviceSelector {
    return {
      type: this.type,
      ...(this.alias !== undefined ? { alias: this.alias } : {}),
      ...(this.pool !== undefined ? { pool: this.pool } : {}),
      ...(this.strategy !== undefined ? { strategy: this.strategy } : {}),
      ...(this.selectors !== undefined ? { selectors: this.selectors.map((s) => (s instanceof DeviceSelectorBuilder ? s.toJSON() : s)) } : {}),
    };
  }
}

function coerceSelector(selector: DeviceSelector): DeviceSelector {
  return selector instanceof DeviceSelectorBuilder ? selector.toJSON() : selector;
}

/** Cloud execution target: run the configured transport on the Fentaris host. @pk */
export interface CloudExecutionTarget {
  readonly kind: "cloud";
}

/** Edge execution target: run on an enrolled device selected by `device`. @pk */
export interface EdgeExecutionTarget {
  readonly kind: "edge";
  /** Device selector for this target. @pk */
  readonly device: DeviceSelector;
  /** Selection strategy for pool selectors declared on the target. @pk */
  readonly strategy?: TargetSelectionStrategy;
}

/** A reusable execution target declaration. @pk */
export type ExecutionTarget = CloudExecutionTarget | EdgeExecutionTarget;

/** Options for {@link edge}. @pk */
export interface EdgeTargetOptions {
  /** Device selector for the target. @pk */
  device: DeviceSelector;
  /** Selection strategy for pool resolution. @pk */
  strategy?: TargetSelectionStrategy;
}

/** The implicit built-in cloud target. @pk */
export const cloud: CloudExecutionTarget = Object.freeze({ kind: "cloud" });

/**
 * Build an edge execution target. Also serves as the namespace for device
 * selector builders ({@link edge.sessionDevice}, {@link edge.userDefaultDevice},
 * {@link edge.namedDevice}, {@link edge.pool}) and setup field builders.
 * @pk
 */
export const edge = Object.assign(
  function edge(options: EdgeTargetOptions): EdgeExecutionTarget {
    if (!options || typeof options !== "object") {
      throw new TypeError("edge() requires an options object with a device selector");
    }
    const device = options.device instanceof DeviceSelectorBuilder ? options.device.toJSON() : options.device;
    if (!device || typeof device.type !== "string") {
      throw new TypeError("edge() requires a device selector");
    }
    return Object.freeze({
      kind: "edge",
      device,
      ...(options.strategy ? { strategy: options.strategy } : {}),
    });
  },
  {
    sessionDevice: (): DeviceSelectorBuilder => DeviceSelectorBuilder.session(),
    userDefaultDevice: (): DeviceSelectorBuilder => DeviceSelectorBuilder.userDefault(),
    namedDevice: (alias: string): DeviceSelectorBuilder => DeviceSelectorBuilder.named(alias),
    pool: (name: string, strategy?: TargetSelectionStrategy): DeviceSelectorBuilder =>
      DeviceSelectorBuilder.pool(name, strategy),
    folder: setupFolder,
    file: setupFile,
    secret: setupSecret,
    string: setupString,
    boolean: setupBoolean,
    number: setupNumber,
    select: setupSelect,
    install: edgeInstall,
  },
);

/** Type guard for a cloud target. @pk */
export function isCloudTarget(target: ExecutionTarget): target is CloudExecutionTarget {
  return target.kind === "cloud";
}

/** Type guard for an edge target. @pk */
export function isEdgeTarget(target: ExecutionTarget): target is EdgeExecutionTarget {
  return target.kind === "edge";
}

/** Target name identifier pattern; conservative and DNS-like for control-plane use. @pk */
const TARGET_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/i;

/** Whether a candidate execution-target name is syntactically valid. @pk */
export function isValidTargetName(name: string): boolean {
  return typeof name === "string" && TARGET_NAME_PATTERN.test(name) && !name.endsWith("-");
}

/** Validate a device selector structure and return collected diagnostic messages. @pk */
export function validateDeviceSelector(selector: DeviceSelector): string[] {
  const errors: string[] = [];
  if (!selector || typeof selector.type !== "string") {
    return ["device selector must have a type"];
  }
  switch (selector.type) {
    case "session":
    case "user-default":
      break;
    case "named":
      if (!selector.alias) errors.push("named device selector requires an alias");
      break;
    case "pool":
      if (!selector.pool) errors.push("pool device selector requires a pool name");
      if (selector.strategy && !["least-loaded", "random", "round-robin", "sticky"].includes(selector.strategy)) {
        errors.push(`unknown pool selection strategy "${selector.strategy}"`);
      }
      break;
    case "fallback":
      if (!Array.isArray(selector.selectors) || selector.selectors.length < 2) {
        errors.push("fallback device selector requires at least two composed selectors");
      } else {
        for (const child of selector.selectors) {
          errors.push(...validateDeviceSelector(child));
        }
      }
      break;
    default:
      errors.push(`unknown device selector type "${selector.type}"`);
  }
  return errors;
}

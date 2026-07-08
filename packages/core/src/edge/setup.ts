/**
 * Typed MCP setup fields and setup schema.
 *
 * The setup schema describes every runtime reference required to launch an MCP.
 * The control plane sends unresolved setup requirements to an enrolled edge;
 * the edge setup provider collects local values. Resolved paths and secrets
 * stay on the edge; only an opaque grant reference and readiness state return
 * to the control plane unless a field is explicitly declared cloud-visible.
 * @pk
 */

import type { EdgeErrorCode } from "./errors.js";

/** Filesystem access level for folder/file grants. @pk */
export type SetupFieldAccess = "read" | "read-write";

/** Setup field kind. @pk */
export type SetupFieldKind =
  | "folder"
  | "file"
  | "secret"
  | "string"
  | "boolean"
  | "number"
  | "select";

/** Common metadata shared by every setup field. @pk */
export interface SetupFieldCommon {
  /** Field name; assigned from the setup schema object key. @pk */
  readonly name: string;
  /** Whether the field must be supplied. Defaults to `true`. @pk */
  readonly required: boolean;
  /** Human-readable label for setup prompts. @pk */
  readonly label?: string;
  /** Description for setup prompts. Must not contain resolved values. @pk */
  readonly description?: string;
  /**
   * Whether the resolved value may be returned to the control plane. Defaults to
   * `false` for sensitive local fields. Only non-sensitive fields may opt in.
   * @pk
   */
  readonly cloudVisible?: boolean;
}

/** Folder grant field. @pk */
export interface FolderSetupField extends SetupFieldCommon {
  readonly kind: "folder";
  /** Requested access for the local directory grant. @pk */
  readonly access: SetupFieldAccess;
}

/** File grant field. @pk */
export interface FileSetupField extends SetupFieldCommon {
  readonly kind: "file";
  /** Requested access for the local file grant. @pk */
  readonly access: SetupFieldAccess;
}

/** Secret field. Never carries a value; never cloud-visible. @pk */
export interface SecretSetupField extends SetupFieldCommon {
  readonly kind: "secret";
  /** A secret field is always required and never cloud-visible. @pk */
}

/** Free-form string field, with an optional safe default. @pk */
export interface StringSetupField extends SetupFieldCommon {
  readonly kind: "string";
  readonly default?: string;
}

/** Boolean field, with an optional safe default. @pk */
export interface BooleanSetupField extends SetupFieldCommon {
  readonly kind: "boolean";
  readonly default?: boolean;
}

/** Number field, with optional safe default and bounds. @pk */
export interface NumberSetupField extends SetupFieldCommon {
  readonly kind: "number";
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
}

/** Select field with a closed value set. @pk */
export interface SelectOption {
  /** Stable value resolved at launch. @pk */
  readonly value: string;
  /** Optional human-readable label. @pk */
  readonly label?: string;
}

export interface SelectSetupField extends SetupFieldCommon {
  readonly kind: "select";
  readonly options: readonly SelectOption[];
  readonly default?: string;
}

/** A typed setup field. @pk */
export type SetupField =
  | FolderSetupField
  | FileSetupField
  | SecretSetupField
  | StringSetupField
  | BooleanSetupField
  | NumberSetupField
  | SelectSetupField;

/** A setup field descriptor before it is keyed into a schema. @pk */
export type SetupFieldDescriptor =
  | Omit<FolderSetupField, "name">
  | Omit<FileSetupField, "name">
  | Omit<SecretSetupField, "name">
  | Omit<StringSetupField, "name">
  | Omit<BooleanSetupField, "name">
  | Omit<NumberSetupField, "name">
  | Omit<SelectSetupField, "name">;

/** A normalized, versioned setup schema. @pk */
export interface SetupSchema {
  /** Schema version; bumped on incompatible field changes. @pk */
  readonly version: number;
  /** Fields keyed by name. @pk */
  readonly fields: Readonly<Record<string, SetupField>>;
}

/** Builder options for folder/file fields. @pk */
export interface FileSystemFieldOptions {
  readonly access?: SetupFieldAccess;
  readonly required?: boolean;
  readonly label?: string;
  readonly description?: string;
}

/** Builder options for simple scalar fields. @pk */
export interface ScalarFieldOptions {
  readonly required?: boolean;
  readonly label?: string;
  readonly description?: string;
  readonly cloudVisible?: boolean;
}

/** Builder options for a select field. @pk */
export interface SelectFieldOptions extends ScalarFieldOptions {
  readonly options: readonly (string | SelectOption)[];
  readonly default?: string;
}

/** Builder options for a number field. @pk */
export interface NumberFieldOptions extends ScalarFieldOptions {
  readonly default?: number;
  readonly min?: number;
  readonly max?: number;
}

function common(
  kind: SetupFieldKind,
  options: ScalarFieldOptions | undefined,
): Pick<SetupFieldCommon, "required" | "label" | "description" | "cloudVisible"> {
  return {
    required: options?.required ?? true,
    ...(options?.label ? { label: options.label } : {}),
    ...(options?.description ? { description: options.description } : {}),
    ...(options?.cloudVisible ? { cloudVisible: true } : {}),
  };
}

/** Build a folder grant field. @pk */
export function folder(options?: FileSystemFieldOptions): Omit<FolderSetupField, "name"> {
  return {
    kind: "folder",
    access: options?.access ?? "read-write",
    required: options?.required ?? true,
    ...(options?.label ? { label: options.label } : {}),
    ...(options?.description ? { description: options.description } : {}),
  };
}

/** Build a file grant field. @pk */
export function file(options?: FileSystemFieldOptions): Omit<FileSetupField, "name"> {
  return {
    kind: "file",
    access: options?.access ?? "read-write",
    required: options?.required ?? true,
    ...(options?.label ? { label: options.label } : {}),
    ...(options?.description ? { description: options.description } : {}),
  };
}

/** Build a secret field. Secrets are always required and never cloud-visible. @pk */
export function secret(options?: Omit<ScalarFieldOptions, "cloudVisible">): Omit<SecretSetupField, "name"> {
  return {
    kind: "secret",
    required: options?.required ?? true,
    ...(options?.label ? { label: options.label } : {}),
    ...(options?.description ? { description: options.description } : {}),
  };
}

/** Build a free-form string field. @pk */
export function string(options?: ScalarFieldOptions & { default?: string }): Omit<StringSetupField, "name"> {
  return {
    ...common("string", options),
    kind: "string",
    ...(options?.default !== undefined ? { default: options.default } : {}),
  };
}

/** Build a boolean field. @pk */
export function boolean(options?: ScalarFieldOptions & { default?: boolean }): Omit<BooleanSetupField, "name"> {
  return {
    ...common("boolean", options),
    kind: "boolean",
    ...(options?.default !== undefined ? { default: options.default } : {}),
  };
}

/** Build a number field. @pk */
export function number(options?: NumberFieldOptions): Omit<NumberSetupField, "name"> {
  return {
    ...common("number", options),
    kind: "number",
    ...(options?.default !== undefined ? { default: options.default } : {}),
    ...(options?.min !== undefined ? { min: options.min } : {}),
    ...(options?.max !== undefined ? { max: options.max } : {}),
  };
}

function normalizeSelectOptions(options: readonly (string | SelectOption)[]): SelectOption[] {
  return options.map((option) => (typeof option === "string" ? { value: option } : { value: option.value, ...(option.label ? { label: option.label } : {}) }));
}

/** Build a select field with a closed value set. @pk */
export function select(options: SelectFieldOptions): Omit<SelectSetupField, "name"> {
  if (!Array.isArray(options.options) || options.options.length === 0) {
    throw new TypeError("select() requires a non-empty options array");
  }
  return {
    ...common("select", options),
    kind: "select",
    options: normalizeSelectOptions(options.options),
    ...(options.default !== undefined ? { default: options.default } : {}),
  };
}

/** A diagnostic produced by setup schema validation. @pk */
export interface SetupDiagnostic {
  readonly severity: "error" | "warning";
  readonly code: `EDGE_SETUP_${string}` | EdgeErrorCode;
  readonly field?: string;
  readonly message: string;
}

/**
 * Build a {@link SetupSchema} from keyed field descriptors. Field names are
 * assigned from the object keys and must be valid identifiers.
 * @pk
 */
export function createSetupSchema(fields: Record<string, SetupFieldDescriptor>, version?: number): SetupSchema {
  const built: Record<string, SetupField> = {};
  for (const [name, descriptor] of Object.entries(fields)) {
    if (!isValidFieldName(name)) {
      throw new TypeError(`invalid setup field name "${name}"`);
    }
    if (!descriptor || typeof descriptor.kind !== "string") {
      throw new TypeError(`setup field "${name}" is not a valid descriptor`);
    }
    built[name] = Object.freeze({ name, ...descriptor }) as SetupField;
  }
  return Object.freeze({ version: version ?? 1, fields: Object.freeze(built) });
}

function isValidFieldName(name: string): boolean {
  return /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * Validate a setup schema and return diagnostics. Rejects unsafe secret
 * defaults, incompatible cloud-visible flags on sensitive fields, select
 * fields without options, and duplicate field names (structurally impossible
 * from `createSetupSchema`, possible when constructed by hand).
 * @pk
 */
export function validateSetupSchema(schema: SetupSchema): SetupDiagnostic[] {
  const diagnostics: SetupDiagnostic[] = [];
  if (!schema || typeof schema.version !== "number" || schema.version < 1) {
    return [{ severity: "error", code: "EDGE_SETUP_INVALID_VERSION", message: "setup schema requires a positive version" }];
  }
  const seen = new Map<string, SetupFieldKind>();
  for (const [name, field] of Object.entries(schema.fields)) {
    if (!isValidFieldName(name)) {
      diagnostics.push({ severity: "error", code: "EDGE_SETUP_INVALID_NAME", field: name, message: `invalid setup field name "${name}"` });
      continue;
    }
    if (seen.has(name)) {
      diagnostics.push({ severity: "error", code: "EDGE_SETUP_DUPLICATE", field: name, message: `duplicate setup field "${name}"` });
    }
    seen.set(name, field.kind);
    if (field.kind === "secret") {
      if ("default" in field && (field as { default?: unknown }).default !== undefined) {
        diagnostics.push({ severity: "error", code: "EDGE_SETUP_UNSAFE_SECRET_DEFAULT", field: name, message: `secret field "${name}" must not declare a default` });
      }
      if (field.cloudVisible) {
        diagnostics.push({ severity: "error", code: "EDGE_SETUP_UNSAFE_SECRET_CLOUD_VISIBLE", field: name, message: `secret field "${name}" must not be cloud-visible` });
      }
    }
    if (("cloudVisible" in field && field.cloudVisible) && (field.kind === "folder" || field.kind === "file")) {
      diagnostics.push({ severity: "warning", code: "EDGE_SETUP_PATH_CLOUD_VISIBLE", field: name, message: `filesystem field "${name}" is cloud-visible; resolved paths should not leave the edge` });
    }
    if (field.kind === "select") {
      if (!field.options || field.options.length === 0) {
        diagnostics.push({ severity: "error", code: "EDGE_SETUP_SELECT_EMPTY", field: name, message: `select field "${name}" requires options` });
      } else if (field.default && !field.options.some((option) => option.value === field.default)) {
        diagnostics.push({ severity: "error", code: "EDGE_SETUP_SELECT_DEFAULT_INVALID", field: name, message: `select field "${name}" default is not among the options` });
      }
    }
    if (field.kind === "number" && field.min !== undefined && field.max !== undefined && field.min > field.max) {
      diagnostics.push({ severity: "error", code: "EDGE_SETUP_NUMBER_RANGE", field: name, message: `number field "${name}" min exceeds max` });
    }
  }
  return diagnostics;
}

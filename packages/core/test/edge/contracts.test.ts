import { describe, expect, it } from "vitest";
import {
  EDGE_ERROR_CODES,
  LAUNCH_RECIPE_VERSION,
  cloud,
  collectRecipeRuntimeRefs,
  compileLaunchRecipe,
  createSetupSchema,
  describeRuntimeValueToken,
  edge,
  edgeError,
  isCloudTarget,
  isEdgeError,
  isEdgeTarget,
  isRuntimeValueToken,
  parseLaunchRecipe,
  runtime,
  serializeLaunchRecipe,
  validateDeviceSelector,
  validateSetupSchema,
} from "../../src/index.js";
import type { DeviceSelector, EdgeExecutionTarget, LaunchRecipe, RuntimeValueToken, SetupField, SetupSchema } from "../../src/index.js";

describe("execution target builders", () => {
  it("cloud is the implicit built-in cloud target", () => {
    expect(cloud).toEqual({ kind: "cloud" });
    expect(isCloudTarget(cloud)).toBe(true);
    expect(isEdgeTarget(cloud)).toBe(false);
  });

  it("edge() builds an edge target with a device selector", () => {
    const target = edge({ device: edge.userDefaultDevice() });
    expect(isEdgeTarget(target)).toBe(true);
    expect(target.kind).toBe("edge");
    expect((target as EdgeExecutionTarget).device.type).toBe("user-default");
  });

  it("edge() rejects a missing device selector", () => {
    expect(() => edge({} as never)).toThrow(TypeError);
  });

  it("serializes selectors without leaking prototype methods", () => {
    const selector = edge.namedDevice("laptop");
    expect(JSON.parse(JSON.stringify(selector))).toEqual({ type: "named", alias: "laptop" });
  });
});

describe("device selector composition", () => {
  it("builds session, user-default, named, and pool selectors", () => {
    expect(edge.sessionDevice().toJSON()).toEqual({ type: "session" });
    expect(edge.userDefaultDevice().toJSON()).toEqual({ type: "user-default" });
    expect(edge.namedDevice("laptop").toJSON()).toEqual({ type: "named", alias: "laptop" });
    expect(edge.pool("team", "least-loaded").toJSON()).toEqual({ type: "pool", pool: "team", strategy: "least-loaded" });
  });

  it("composes selectors with or() into an ordered fallback", () => {
    const composed = edge.sessionDevice().or(edge.userDefaultDevice()).or(edge.namedDevice("laptop"));
    const json = JSON.parse(JSON.stringify(composed)) as DeviceSelector;
    expect(json.type).toBe("fallback");
    expect(json.selectors?.[0]).toEqual({ type: "fallback", selectors: [{ type: "session" }, { type: "user-default" }] });
    expect(json.selectors?.[1]).toEqual({ type: "named", alias: "laptop" });
  });

  it("validates selector structure", () => {
    expect(validateDeviceSelector(edge.userDefaultDevice().toJSON())).toEqual([]);
    expect(validateDeviceSelector({ type: "named" } as DeviceSelector)).toContain("named device selector requires an alias");
    expect(validateDeviceSelector({ type: "fallback", selectors: [edge.sessionDevice().toJSON()] } as DeviceSelector)).toContain(
      "fallback device selector requires at least two composed selectors",
    );
  });
});

describe("runtime value tokens", () => {
  it("builds input and secret tokens referencing setup fields", () => {
    const input = runtime.input("workspace");
    const secret = runtime.secret("token");
    expect(isRuntimeValueToken(input)).toBe(true);
    expect(input.kind).toBe("input");
    expect(input.ref).toBe("workspace");
    expect(secret.kind).toBe("secret");
    expect(secret.ref).toBe("token");
  });

  it("tokens carry no resolved value", () => {
    const token = runtime.secret("token");
    expect(Object.keys(token).sort()).toEqual(["__fentarisRuntimeValue", "kind", "ref"]);
    expect(Object.getOwnPropertyDescriptor(token, "ref")?.writable).toBe(false);
  });

  it("survives serialization round-trip", () => {
    const token = runtime.input("workspace");
    const roundTrip = JSON.parse(JSON.stringify(token)) as RuntimeValueToken;
    expect(isRuntimeValueToken(roundTrip)).toBe(true);
    expect(roundTrip.ref).toBe("workspace");
  });

  it("describes tokens without leaking values", () => {
    expect(describeRuntimeValueToken(runtime.secret("token"))).toBe('runtime.secret("token")');
  });

  it("rejects empty field names", () => {
    expect(() => runtime.input("")).toThrow(TypeError);
    expect(() => runtime.secret("  ")).toThrow(TypeError);
  });
});

describe("setup field builders", () => {
  it("builds folder and file fields with access", () => {
    expect(edge.folder({ access: "read" })).toMatchObject({ kind: "folder", access: "read", required: true });
    expect(edge.file({ access: "read-write" })).toMatchObject({ kind: "file", access: "read-write" });
  });

  it("builds a secret field that defaults to required and is never cloud-visible", () => {
    expect(edge.secret()).toMatchObject({ kind: "secret", required: true });
    expect("cloudVisible" in (edge.secret() as unknown as object)).toBe(false);
  });

  it("builds scalar fields with safe defaults", () => {
    expect(edge.string({ default: "x", required: false })).toMatchObject({ kind: "string", default: "x", required: false });
    expect(edge.boolean({ default: true })).toMatchObject({ kind: "boolean", default: true });
    expect(edge.number({ default: 3, min: 0, max: 10 })).toMatchObject({ kind: "number", default: 3, min: 0, max: 10 });
  });

  it("builds a select field with normalized options", () => {
    const field = edge.select({ options: ["a", { value: "b", label: "Bee" }] }) as SetupField;
    expect(field.kind).toBe("select");
    if (field.kind === "select") {
      expect(field.options).toEqual([{ value: "a" }, { value: "b", label: "Bee" }]);
    }
  });

  it("rejects an empty select option set", () => {
    expect(() => edge.select({ options: [] })).toThrow(TypeError);
  });

  it("createSetupSchema assigns names from keys and freezes the schema", () => {
    const schema = createSetupSchema({
      workspace: edge.folder({ access: "read-write" }),
      token: edge.secret(),
    });
    expect(schema.version).toBe(1);
    expect(schema.fields.workspace).toMatchObject({ name: "workspace", kind: "folder", access: "read-write" });
    expect(Object.isFrozen(schema)).toBe(true);
    expect(Object.isFrozen(schema.fields)).toBe(true);
  });

  it("rejects invalid field names", () => {
    expect(() => createSetupSchema({ "1bad": edge.string() })).toThrow(TypeError);
  });
});

describe("setup schema validation", () => {
  it("accepts a well-formed schema", () => {
    const schema = createSetupSchema({ workspace: edge.folder(), token: edge.secret() });
    expect(validateSetupSchema(schema)).toEqual([]);
  });

  it("rejects unsafe secret defaults", () => {
    const schema: SetupSchema = {
      version: 1,
      fields: { token: { kind: "secret", name: "token", required: true, default: "leak" } as SetupField },
    };
    const diagnostics = validateSetupSchema(schema);
    expect(diagnostics.some((d) => d.code === "EDGE_SETUP_UNSAFE_SECRET_DEFAULT")).toBe(true);
  });

  it("rejects secret cloud-visible flag", () => {
    const schema: SetupSchema = {
      version: 1,
      fields: { token: { kind: "secret", name: "token", required: true, cloudVisible: true } as SetupField },
    };
    expect(validateSetupSchema(schema).some((d) => d.code === "EDGE_SETUP_UNSAFE_SECRET_CLOUD_VISIBLE")).toBe(true);
  });

  it("rejects invalid select defaults", () => {
    const schema: SetupSchema = {
      version: 1,
      fields: { mode: { kind: "select", name: "mode", required: true, options: [{ value: "a" }], default: "b" } as SetupField },
    };
    expect(validateSetupSchema(schema).some((d) => d.code === "EDGE_SETUP_SELECT_DEFAULT_INVALID")).toBe(true);
  });
});

describe("launch recipe compilation and serialization", () => {
  it("compiles a recipe from stdio options and collects runtime refs", () => {
    const recipe = compileLaunchRecipe({
      command: "server",
      args: ["--workspace", runtime.input("workspace")],
      env: { TOKEN: runtime.secret("token"), STATIC: "keep" },
      stderr: "pipe",
    });
    expect(recipe.version).toBe(LAUNCH_RECIPE_VERSION);
    expect(recipe.command).toBe("server");
    expect(recipe.setupFieldRefs).toEqual(["token", "workspace"]);
    expect(recipe.args[1]).toMatchObject({ ref: "workspace" });
    expect(recipe.digest).toMatch(/^sha256:/);
  });

  it("serializeLaunchRecipe and parseLaunchRecipe round-trip and verify the digest", () => {
    const recipe = compileLaunchRecipe({
      command: "server",
      args: ["--x", runtime.input("x")],
      env: { S: runtime.secret("s") },
    });
    const parsed = parseLaunchRecipe(serializeLaunchRecipe(recipe));
    expect(parsed).toEqual(recipe);
    expect(parsed.digest).toBe(recipe.digest);
  });

  it("collectRecipeRuntimeRefs deduplicates and sorts", () => {
    expect(
      collectRecipeRuntimeRefs([runtime.input("b"), runtime.secret("a"), runtime.input("b")], { X: runtime.secret("a") }),
    ).toEqual(["a", "b"]);
  });

  it("parseLaunchRecipe rejects a tampered digest", () => {
    const recipe = compileLaunchRecipe({ command: "server", args: ["ok"] });
    const tampered = JSON.parse(serializeLaunchRecipe(recipe)) as LaunchRecipe;
    tampered.command = "evil";
    expect(() => parseLaunchRecipe(JSON.stringify(tampered))).toThrow();
  });

  it("parseLaunchRecipe rejects unsupported versions and malformed payloads", () => {
    expect(() => parseLaunchRecipe("not-json")).toThrow();
    expect(() => parseLaunchRecipe(JSON.stringify({ version: 999, command: "x", args: [], env: {} }))).toThrow();
  });
});

describe("edge errors", () => {
  it("produces a normalized error with a stable code", () => {
    const err = edgeError("EDGE_UNAVAILABLE", "no eligible device", { details: { target: "personal" } });
    expect(isEdgeError(err)).toBe(true);
    expect(err.code).toBe("EDGE_UNAVAILABLE");
    expect(err.name).toBe("EdgeError[EDGE_UNAVAILABLE]");
    expect(err.details).toEqual({ target: "personal" });
    expect(err.message).toBe("no eligible device");
  });

  it("exposes a stable code list", () => {
    expect(EDGE_ERROR_CODES).toContain("EDGE_PLACEMENT_AMBIGUOUS");
    expect(EDGE_ERROR_CODES).toContain("EDGE_UNRESOLVED_RUNTIME_INPUT");
    expect(new Set(EDGE_ERROR_CODES).size).toBe(EDGE_ERROR_CODES.length);
  });
});

describe("stdio runtime token compatibility", () => {
  it("runtime tokens are accepted in stdio options types and detected by guards", () => {
    const options = {
      command: "server",
      args: ["--workspace", runtime.input("workspace")],
      env: { TOKEN: runtime.secret("token") },
    };
    const recipe = compileLaunchRecipe(options);
    expect(recipe.setupFieldRefs).toEqual(["token", "workspace"]);
    expect(isRuntimeValueToken(options.args[1])).toBe(true);
  });
});

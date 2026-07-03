/**
 * Edge execution public contracts: execution targets, device selectors,
 * runtime-value tokens, setup fields/schema, launch recipes, and error codes.
 * @pk
 */

import { edge } from "./target.js";
import * as setup from "./setup.js";

// Attach setup field builders to the `edge` namespace so applications can call
// `edge.folder()`, `edge.secret()`, etc. directly, matching the design where
// `edge` is both a target builder and the setup/selector namespace. @pk
(edge as unknown as {
  folder: typeof setup.folder;
  file: typeof setup.file;
  secret: typeof setup.secret;
  string: typeof setup.string;
  boolean: typeof setup.boolean;
  number: typeof setup.number;
  select: typeof setup.select;
}).folder = setup.folder;
(edge as unknown as { file: typeof setup.file }).file = setup.file;
(edge as unknown as { secret: typeof setup.secret }).secret = setup.secret;
(edge as unknown as { string: typeof setup.string }).string = setup.string;
(edge as unknown as { boolean: typeof setup.boolean }).boolean = setup.boolean;
(edge as unknown as { number: typeof setup.number }).number = setup.number;
(edge as unknown as { select: typeof setup.select }).select = setup.select;

export {
  cloud,
  edge,
  DeviceSelectorBuilder,
  isCloudTarget,
  isEdgeTarget,
  isValidTargetName,
  validateDeviceSelector,
} from "./target.js";
export type {
  DeviceSelector,
  DeviceSelectorType,
  EdgeExecutionTarget,
  EdgeTargetOptions,
  ExecutionTarget,
  CloudExecutionTarget,
  TargetKind,
  TargetSelectionStrategy,
} from "./target.js";

export {
  runtime,
  isRuntimeValueToken,
  describeRuntimeValueToken,
  runtimeValueRef,
  RUNTIME_VALUE_TOKEN_BRAND,
} from "./runtimeInput.js";
export type { RuntimeValueToken, RuntimeValueTokenKind } from "./runtimeInput.js";

export {
  createSetupSchema,
  validateSetupSchema,
  folder,
  file,
  secret,
  string,
  boolean,
  number,
  select,
} from "./setup.js";
export type {
  BooleanSetupField,
  FileSetupField,
  FolderSetupField,
  NumberFieldOptions,
  NumberSetupField,
  ScalarFieldOptions,
  SelectFieldOptions,
  SelectOption,
  SelectSetupField,
  SecretSetupField,
  SetupDiagnostic,
  SetupField,
  SetupFieldAccess,
  SetupFieldDescriptor,
  SetupFieldKind,
  SetupSchema,
  StringSetupField,
  FileSystemFieldOptions,
} from "./setup.js";

export {
  compileLaunchRecipe,
  computeRecipeDigest,
  collectRecipeRuntimeRefs,
  LAUNCH_RECIPE_VERSION,
  parseLaunchRecipe,
  serializeLaunchRecipe,
} from "./recipe.js";
export type { LaunchRecipe } from "./recipe.js";

export { EDGE_ERROR_CODES, edgeError, isEdgeError } from "./errors.js";
export type { EdgeError, EdgeErrorCode, EdgeErrorOptions } from "./errors.js";
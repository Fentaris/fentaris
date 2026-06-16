export { FentarisConfigError } from "./error.js";
export { formatFentarisDiagnostics } from "./format.js";
export { assertValidFentarisConfig, defineFentarisConfig, validateFentarisConfig } from "./validation.js";
export type { FentarisConfigValidationOptions } from "./validation.js";
export type {
  FentarisConfigPath,
  FentarisConfigValidationResult,
  FentarisDiagnostic,
  FentarisDiagnosticFormat,
  FentarisDiagnosticFormatterOptions,
  FentarisDiagnosticRelatedEntry,
  FentarisDiagnosticSeverity,
  FentarisDiagnosticSuggestion,
} from "./diagnostics.js";

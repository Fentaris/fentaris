import type { FentarisDiagnostic, FentarisDiagnosticFormatterOptions } from "./diagnostics.js";
import { formatFentarisDiagnostics } from "./format.js";

/**
 * Error thrown when Fentaris configuration validation reports error diagnostics.
 * @pk
 */
export class FentarisConfigError extends Error {
  readonly diagnostics: FentarisDiagnostic[];

  constructor(diagnostics: readonly FentarisDiagnostic[], message?: string) {
    super(message ?? formatFentarisDiagnostics(diagnostics, { format: "plain" }));
    this.name = "FentarisConfigError";
    this.diagnostics = [...diagnostics];
  }

  format(options: FentarisDiagnosticFormatterOptions = {}): string {
    return formatFentarisDiagnostics(this.diagnostics, options);
  }

  toJSON(): { name: string; message: string; diagnostics: FentarisDiagnostic[] } {
    return {
      name: this.name,
      message: this.message,
      diagnostics: this.diagnostics,
    };
  }
}

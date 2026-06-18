import { readFile } from "node:fs/promises";

const credentialPattern = /\bcredential\s*\(\s*["']([^"']+)["']\s*\)/gu;
const credentialEnvPattern = /\bcredentialEnv\s*\(\s*["']([^"']+)["']\s*\)/gu;

export type ManifestScanResult = {
  references: Array<{ ref: string; scope: string }>;
  envVars: string[];
};

/**
 * Scan a TypeScript entrypoint for credential references.
 */
export async function scanEntrypointForSecrets(entrypointPath: string): Promise<ManifestScanResult> {
  const source = await readFile(entrypointPath, "utf8");
  return scanSourceForSecrets(source);
}

/**
 * Scan TypeScript source for credential references.
 */
export function scanSourceForSecrets(source: string): ManifestScanResult {
  const refs = new Set<string>();
  const envVars = new Set<string>();

  for (const pattern of [credentialPattern, /credential\s*\(\s*`([^`]+)`\s*\)/gu]) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const ref = match[1]?.trim();
      if (ref) {
        refs.add(ref);
      }
    }
  }

  credentialEnvPattern.lastIndex = 0;
  for (const match of source.matchAll(credentialEnvPattern)) {
    const envVar = match[1]?.trim();
    if (envVar) {
      envVars.add(envVar);
    }
  }

  return {
    references: [...refs].sort().map((ref) => ({ ref, scope: "default" })),
    envVars: [...envVars].sort(),
  };
}

import { stripTypeScriptTypes } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { hashFile } from "./lib.mjs";

/** Materialize only fixture utilities; all product imports resolve to the packed consumer. */
export async function materializeFixtures(candidateRoot, project) {
  const identities = [];
  for (const name of ["authorizationServer", "protectedMcpServer", "elicitingClient"]) {
    const source = path.join(candidateRoot, "packages/core/test/fixtures/oauth", `${name}.ts`);
    const code = stripTypeScriptTypes(await readFile(source, "utf8"), { mode: "transform" }).replaceAll('"./authorizationServer.js"', '"./authorizationServer.mjs"');
    const destination = path.join(project, `${name}.mjs`);
    await writeFile(destination, code);
    identities.push({ fixture: name, sourceDigest: await hashFile(source), materializedDigest: await hashFile(destination) });
  }
  return identities;
}

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [edgeEntry, project, attemptName] = process.argv.slice(2);
if (!edgeEntry || !project || !attemptName) throw new Error("Usage: native-launchd.mjs <edge-entry> <project> <attempt-name>");
if (process.platform !== "darwin") throw new Error("Native launchd verification requires macOS.");

const { LaunchdEdgeServiceAdapter } = await import(pathToFileURL(edgeEntry));
const label = `dev.fentaris.edge.verify.${attemptName.replaceAll(/[^a-zA-Z0-9.-]/g, "-")}`;
const plist = path.join(project, `${label}.plist`);
const heartbeat = path.join(project, "heartbeat.txt");
const worker = path.join(project, "worker.mjs");
await writeFile(worker, `import { appendFile } from "node:fs/promises";\nconst file = process.argv[2];\nawait appendFile(file, "start\\n");\nsetInterval(() => {}, 1000);\n`, { mode: 0o700 });
const adapter = new LaunchdEdgeServiceAdapter(plist, undefined, undefined, process.getuid(), label);
let installed = false;
try {
  await adapter.install({ executable: process.execPath, args: [worker, heartbeat], workingDirectory: project, environment: { FENTARIS_EDGE_STATE_DIR: path.join(project, "state") } });
  installed = true;
  await waitFor(heartbeat);
  await adapter.start();
  await adapter.restart();
  await adapter.stop();
} finally {
  if (installed) await adapter.uninstall();
}
await access(heartbeat);

async function waitFor(file) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await access(file); return; } catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  throw new Error("launchd worker did not start");
}

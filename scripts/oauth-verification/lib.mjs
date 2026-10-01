import path from "node:path";
export { allocateAttempt, initializeAttempt, runLogged, hashFile, packCandidateArtifacts, scanArtifacts } from "../verification/lib.mjs";

export function requirementMatrix(requirements, results) {
  return requirements.map((requirement) => {
    const evidence = requirement.scenarios.map((id) => results.find((result) => result.id === id));
    return { ...requirement, status: evidence.some((result) => result?.status === "FAIL") ? "FAIL" : evidence.every((result) => result?.status === "PASS" && result.commands?.length > 0) ? "PASS" : "BLOCKED" };
  });
}
export function verdict(results, matrix, leaks, integrityErrors = []) {
  if (leaks.length || integrityErrors.length || results.some((result) => result.status === "FAIL")) return "FAIL";
  if (results.length === 0 || matrix.length === 0) return "BLOCKED";
  return matrix.every((row) => row.status === "PASS") && results.every((result) => result.status === "PASS") ? "PASS" : "BLOCKED";
}
const cell = (value) => String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
export function renderReport({ attempt, identity, artifacts, results, matrix, verdict, leaks, mcpjamVersion, integrityErrors }) {
  const link = (file) => `[${cell(path.relative(attempt, file))}](${path.relative(attempt, file)})`;
  return `# Fentaris OAuth practical verification\n\n**${verdict}**\n\n- Candidate: ${identity.branch} at ${identity.sourceHead}\n- Tree: ${identity.tree}\n- Target dev: ${identity.targetDev}\n- mcpjam CLI: ${mcpjamVersion}\n- Node: ${process.version}\n- Attempt: ${attempt}\n\n## Packed candidate\n\n${artifacts.map((artifact) => `- ${link(artifact.file)}: ${artifact.digest}`).join("\n")}\n\n## Scenarios\n\n${results.map((result) => `- ${result.id}: **${result.status}**${result.reason ? ` — ${cell(result.reason)}` : ""}`).join("\n")}\n\n## Requirement matrix\n\n| Source | Requirement | Scenarios | Status |\n|---|---|---|---|\n${matrix.map((row) => `| ${cell(row.source)} | ${cell(row.title)} | ${row.scenarios.join(", ")} | ${row.status} |`).join("\n")}\n\n## Command evidence\n\n| Command | Exit | stdout | stderr |\n|---|---:|---|---|\n${results.flatMap((result) => result.commands ?? []).map((record) => `| ${cell(record.command.join(" "))} | ${record.exitCode} | ${link(record.stdoutPath)} | ${link(record.stderrPath)} |`).join("\n")}\n\n## Integrity and secrecy\n\n- Sentinel leaks: ${leaks.length}\n- Candidate integrity errors: ${integrityErrors.length ? integrityErrors.map(cell).join("; ") : "none"}\n- Tokens, refresh tokens and authorization codes are scanned before report publication. Leaks are redacted and fail the campaign.\n`;
}

#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createDefaultEdgeAgent, EdgeAgent, WebSocketEdgeConnectionClient } from "./agent.js";
import { runEdgeCli, type EdgeCliIo } from "./cli.js";

export {
  EdgeAgent,
  WebSocketEdgeConnectionClient,
  createDefaultEdgeAgent,
  runEdgeCli,
};
export type {
  DefaultAgentOptions,
  EdgeAgentOptions,
  EdgeAgentStatus,
  EdgeRuntimeSummary,
  EdgeRuntimeSummaryProvider,
} from "./agent.js";
export type { EdgeCliIo } from "./cli.js";
export {
  EdgeEnrollmentService,
  HttpDeviceAuthorizationProvider,
  HttpEdgeEnrollmentClient,
} from "./enrollment.js";
export type {
  DeviceAuthorizationPollResult,
  DeviceAuthorizationProvider,
  DeviceAuthorizationRequest,
  EdgeAuthorizationTokens,
  EdgeConnection,
  EdgeConnectionClient,
  EdgeEnrollmentClient,
  EdgeEnrollmentRequest,
  EdgeEnrollmentResult,
  EdgeEnrollmentServiceOptions,
  EdgeLoginResult,
  EnrollmentCallbacks,
} from "./enrollment.js";
export {
  NodeProcessSupervisor,
  ProtectedFileCredentialStore,
  ProtectedJsonStore,
  defaultEdgePaths,
  nodeEdgePlatform,
} from "./platform.js";
export type {
  CredentialStore,
  EdgeLocalConfig,
  EdgePaths,
  EdgePlatform,
  JsonStore,
  ProcessStartOptions,
  ProcessSupervisorAdapter,
  StoredDeviceKeyPair,
  SupervisedProcess,
} from "./platform.js";
export { redactEdgeValue, safeEdgeError } from "./redaction.js";
export {
  LocalSetupManager,
  TerminalSetupProvider,
} from "./setup.js";
export { EdgeWorkloadSupervisor } from "./supervisor.js";
export type {
  DeploymentReconcileResult,
  EdgeWorkload,
  EdgeWorkloadFactory,
  EdgeWorkloadPolicy,
  EdgeWorkloadSupervisorOptions,
  LocalMcpClient,
  SupervisedDesiredDeployment,
} from "./supervisor.js";
export type {
  CompiledLocalLaunchPlan,
  DesiredSetupRequirement,
  LocalGrantDatabase,
  LocalGrantRecord,
  LocalSetupManagerOptions,
  LocalSetupProvider,
  LocalSetupState,
  LocalSetupStatus,
  SetupFieldResponse,
  TerminalSetupPrompter,
} from "./setup.js";

export async function main(
  argv: readonly string[],
  options: {
    agent?: EdgeAgent;
    io?: EdgeCliIo;
    controlPlaneUrl?: string;
  } = {},
): Promise<number> {
  const io = options.io ?? {
    out: (value: string) => console.log(value),
    error: (value: string) => console.error(value),
  };
  const agent = options.agent ?? createDefaultEdgeAgent({
    controlPlaneUrl: options.controlPlaneUrl ?? process.env.FENTARIS_EDGE_CONTROL_PLANE_URL ?? "",
    onVerification: (request) => {
      io.out(JSON.stringify({
        verificationUri: request.verificationUri,
        userCode: request.userCode,
      }));
    },
  });
  return runEdgeCli(argv, agent, io);
}

export function isDirectCliInvocation(entrypointUrl = import.meta.url, argvPath = process.argv[1]): boolean {
  if (!argvPath) return false;
  return resolvePath(fileURLToPath(entrypointUrl)) === resolvePath(argvPath);
}

if (isDirectCliInvocation()) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

function resolvePath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

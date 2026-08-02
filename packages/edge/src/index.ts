#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { createDefaultEdgeAgent, EdgeAgent, WebSocketEdgeConnectionClient } from "./agent.js";
import { runEdgeCli, type EdgeCliIo, type EdgeCliOperations } from "./cli.js";
import { EdgePersistentAgent, FileEdgeSingletonLock, type EdgePersistentStatus } from "./daemon.js";
import { EdgeLocalControlServer, createEdgeLocalControlCredential, edgeLocalControlAddress } from "./localControl.js";
import { ProtectedJsonStore, defaultEdgePaths, nodeEdgePlatform } from "./platform.js";
import { edgeServiceAdapter } from "./service.js";

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
export type { EdgeCliIo, EdgeCliOperations } from "./cli.js";
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
  EdgeJoinMetadata,
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
  NodeTerminalSetupPrompter,
  TerminalSetupProvider,
} from "./setup.js";
export { EdgeWorkloadSupervisor, ExecutableAllowlistPolicy } from "./supervisor.js";
export { StdioEdgeWorkloadFactory } from "./stdioWorkload.js";
export { EdgeAgentRuntime } from "./runtime.js";
export {
  EdgePersistentAgent,
  FileEdgeSingletonLock,
  classifyReconnectError,
  reconnectDelay,
} from "./daemon.js";
export type {
  EdgePersistentAgentOptions,
  EdgePersistentLifecycleState,
  EdgePersistentStatus,
  EdgeReconnectPolicy,
  EdgeSingletonLease,
  EdgeSingletonLock,
} from "./daemon.js";
export {
  EdgeLocalControlServer,
  callEdgeLocalControl,
  createEdgeLocalControlCredential,
  edgeLocalControlAddress,
} from "./localControl.js";
export type {
  EdgeLocalControlCommand,
  EdgeLocalControlEndpoint,
  EdgeLocalControlRequest,
  EdgeLocalControlResponse,
  EdgeLocalControlServerOptions,
} from "./localControl.js";
export {
  ForegroundEdgeServiceAdapter,
  LaunchdEdgeServiceAdapter,
  NodeEdgeServiceCommandRunner,
  NodeEdgeServiceFiles,
  SystemdUserEdgeServiceAdapter,
  WindowsUserEdgeServiceAdapter,
  edgeServiceAdapter,
} from "./service.js";
export type {
  EdgeServiceAdapter,
  EdgeServiceCommandRunner,
  EdgeServiceDefinition,
  EdgeServiceFiles,
  EdgeServiceOperation,
  EdgeServiceResult,
} from "./service.js";
export type {
  EdgeAgentRuntimeOptions,
  EdgeConnectionRuntime,
  EdgeRuntimeConnection,
} from "./runtime.js";
export type {
  DeploymentReconcileResult,
  EdgeWorkload,
  EdgeWorkloadFactory,
  EdgeWorkloadPolicy,
  EdgeWorkloadSupervisorOptions,
  ExecutableAllowlistPolicyOptions,
  LocalMcpClient,
  LocalMcpCapabilityManifest,
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
  const joinUrl = argv[0] === "join" && argv[1] && !argv[1].startsWith("-") ? argv[1] : undefined;
  const paths = defaultEdgePaths();
  const platform = nodeEdgePlatform(paths);
  const agent = options.agent ?? createDefaultEdgeAgent({
    controlPlaneUrl: options.controlPlaneUrl ?? joinUrl ?? process.env.FENTARIS_EDGE_CONTROL_PLANE_URL ?? "",
    platform,
    onVerification: (request) => {
      io.out(JSON.stringify({
        verificationUri: request.verificationUri,
        userCode: request.userCode,
      }));
    },
  });
  const service = edgeServiceAdapter({
    serviceFile: process.platform === "darwin"
      ? path.join(process.env.HOME ?? paths.dataDir, "Library", "LaunchAgents", "dev.fentaris.edge.plist")
      : path.join(process.env.HOME ?? paths.dataDir, ".config", "systemd", "user", "fentaris-edge.service"),
    foregroundCommand: "fentaris edge run",
  });
  const definition = { executable: process.execPath, args: [process.argv[1] ?? "fentaris-edge", "run"] };
  const operations: EdgeCliOperations = {
    installService: () => service.install(definition),
    service: (operation) => operation === "install" ? service.install(definition) : service[operation](),
    run: async () => {
      const persistent = new EdgePersistentAgent({
        agent,
        lock: new FileEdgeSingletonLock(path.join(paths.dataDir, "agent.lock")),
        statusStore: new ProtectedJsonStore<EdgePersistentStatus>(path.join(paths.dataDir, "status.json")),
      });
      const credentialStoreKey = "local-control-credential";
      let credential = await platform.credentialStore.get(credentialStoreKey);
      if (!credential) {
        credential = createEdgeLocalControlCredential();
        await platform.credentialStore.set(credentialStoreKey, credential);
      }
      const control = new EdgeLocalControlServer({
        endpoint: { address: edgeLocalControlAddress(paths.dataDir), credential },
        agent: persistent,
      });
      await persistent.start();
      await control.start();
      try {
        await persistent.wait();
      } finally {
        await control.stop();
      }
    },
  };
  return runEdgeCli(argv, agent, io, operations);
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

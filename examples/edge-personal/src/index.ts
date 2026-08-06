import {
  McpProxy,
  McpServer,
  Policy,
  edge,
  type DeviceResolver,
  type FentarisTransport,
} from "@fentaris/core";

/** Personal-device transparent routing with session selection and immutable pinning. */
export function createPersonalEdgeApp(options: {
  cloudDiscoveryTransport: FentarisTransport;
  edgeTransport: FentarisTransport;
  deviceResolver: DeviceResolver;
}): McpProxy {
  return new McpProxy({
    servers: [new McpServer({ name: "filesystem", transport: options.cloudDiscoveryTransport })],
    policy: Policy.allowAll(),
    targets: { personal: edge({ device: edge.userDefaultDevice() }) },
    placements: [{ serverName: "filesystem", scope: "global", targetName: "personal" }],
    edge: { deviceResolver: options.deviceResolver, transport: options.edgeTransport },
  });
}

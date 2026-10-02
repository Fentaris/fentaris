export const MCPJAM_CLI_VERSION = "5.12.1";
export const MCPJAM_SDK_VERSION = "8.20.0";
export const PROTOCOL_VERSION = "2025-11-25";
export const SCENARIOS = [
  ["01-upstream-dcr-elicitation", "Upstream dynamic registration with URL elicitation"],
  ["02-upstream-preregistered-cli-login", "Upstream CLI login and persistent authorization"],
  ["03-upstream-client-credentials", "Shared upstream client credentials"],
  ["04-inbound-dcr-headless", "Inbound DCR headless OAuth conformance"],
  ["05-inbound-preregistered-headless", "Inbound pre-registered headless OAuth conformance"],
  ["06-inbound-login-tools-call", "Inbound login, tools/list and tools/call"],
  ["07-api-key-still-works", "API-key fallback with OAuth enabled"],
].map(([id, title]) => ({ id, title }));

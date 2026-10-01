// Requirement titles refer to canonical shared-store specs; no local OpenSpec copy.
export const REQUIREMENTS = [
  { source: "upstream-oauth", title: "OAuth upstream auth declaration", scenarios: ["01-upstream-dcr-elicitation", "02-upstream-preregistered-cli-login", "03-upstream-client-credentials"] },
  { source: "oauth-consent-ux", title: "Authorization URL delivery through elicitation", scenarios: ["01-upstream-dcr-elicitation"] },
  { source: "cli-oauth-login", title: "CLI OAuth login", scenarios: ["02-upstream-preregistered-cli-login"] },
  { source: "oauth-token-store", title: "Local store separation and durability", scenarios: ["02-upstream-preregistered-cli-login"] },
  { source: "upstream-oauth", title: "Client credentials grant", scenarios: ["03-upstream-client-credentials"] },
  { source: "inbound-oauth-resource-server", title: "OAuth identity strategy", scenarios: ["04-inbound-dcr-headless", "05-inbound-preregistered-headless", "06-inbound-login-tools-call"] },
  { source: "inbound-oauth-resource-server", title: "Protected resource metadata", scenarios: ["04-inbound-dcr-headless", "05-inbound-preregistered-headless"] },
  { source: "inbound-oauth-resource-server", title: "Bearer challenge on unauthorized responses", scenarios: ["04-inbound-dcr-headless", "05-inbound-preregistered-headless"] },
  { source: "inbound-oauth-resource-server", title: "Resource server only", scenarios: ["04-inbound-dcr-headless"] },
  { source: "inbound-oauth-resource-server", title: "Session binding with OAuth identity", scenarios: ["04-inbound-dcr-headless", "05-inbound-preregistered-headless"] },
  { source: "inbound-oauth-resource-server", title: "Coexistence with declared users and API keys", scenarios: ["07-api-key-still-works"] },
  { source: "oauth-practical-verification", title: "Inbound conformance scenarios", scenarios: ["04-inbound-dcr-headless", "05-inbound-preregistered-headless", "06-inbound-login-tools-call", "07-api-key-still-works"] },
  { source: "oauth-practical-verification", title: "Upstream OAuth scenarios", scenarios: ["01-upstream-dcr-elicitation", "02-upstream-preregistered-cli-login", "03-upstream-client-credentials"] },
];

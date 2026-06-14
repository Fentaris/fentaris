/**
 * Experimental plugin contracts.
 *
 * These types reserve the shape of future plugin support. They do not provide
 * plugin discovery, loading, activation, permission negotiation, auth
 * integration, or CLI management.
 *
 * @experimental
 */
export type {
  PluginCapabilities,
  PluginContext,
  PluginLifecycleHooks,
  PluginLoader,
  PluginManifest,
  PluginRegistration,
  PluginRegistry,
} from "../plugins/index.js";

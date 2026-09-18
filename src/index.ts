export { createKernel, type Kernel, type KernelOptions, type StartWebOptions } from './kernel.ts'
export { CommandRegistry } from './registry.ts'
export { Host, type HostEntry, type HostOptions, type AdoptedState } from './host.ts'
export {
  readManifest,
  discoverPluginDirs,
  discoverPlugins,
  loadDiscovered,
  loadPlugins,
  isDisabled,
  type LoadReport,
  type LoadFailure,
  type LoadOptions,
  type DiscoverReport,
  type PluginDiscovery,
  type SourceReport,
} from './loader.ts'
export {
  readConfig,
  expandEnvDeep,
  expandCredentialRefs,
  expandCredentialRefsDeep,
  type CredentialResolver,
  type CredentialExpansionOptions,
} from './config.ts'
export { readRawConfig, updateConfigFile, renderConfigPath } from './configfile.ts'
export { resolveSource } from './sources.ts'
// The credentials SERVICE DEFINITION (the contract, no provider vocabulary) and
// the core PROVIDERS that ship with the core. An external provider implements
// the definition; a consumer uses the definition. Neither may import the other:
// `npm run check:seam` enforces the direction Provider -> Definition <- Consumer.
export * from './credentials/definition.ts'
export { CORE_PROVIDERS, CORE_PROVIDER_IDS, registerCoreProviders, type CoreProvider } from './credentials/providers/index.ts'
// The WEB seam: the definition (what a UI plugin registers routes, assets and
// pages with) plus the core `node:http` provider the composition root wires.
export * from './web/definition.ts'
export { createWebServer, MAX_BODY_BYTES, type WebServer, type WebServerOptions } from './web/providers/http.ts'
export * from './types.ts'

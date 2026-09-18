export { createKernel, type Kernel, type KernelOptions } from './kernel.ts'
export { CommandRegistry } from './registry.ts'
export {
  readManifest,
  discoverPluginDirs,
  loadPlugins,
  type LoadReport,
  type LoadFailure,
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
export { resolveSource } from './sources.ts'
// The credentials SERVICE DEFINITION (the contract, no provider vocabulary) and
// the core PROVIDERS that ship with the core. An external provider implements
// the definition; a consumer uses the definition. Neither may import the other:
// `npm run check:seam` enforces the direction Provider -> Definition <- Consumer.
export * from './credentials/definition.ts'
export { CORE_PROVIDERS, CORE_PROVIDER_IDS, registerCoreProviders, type CoreProvider } from './credentials/providers/index.ts'
export * from './types.ts'

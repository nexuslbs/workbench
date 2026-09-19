export { createKernel, type Kernel, type KernelOptions } from './kernel.ts'
export { CommandRegistry } from './registry.ts'
export { Host, type HostEntry, type HostOptions, type AdoptedState } from './host.ts'
export {
  readManifest,
  discoverPluginDirs,
  discoverPlugins,
  loadDiscovered,
  loadPlugins,
  isDisabled,
  isRosterMember,
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
export { resolveSource, sourceId, redactArgs, type ResolvedSource, type SourceAuthOutcome } from './sources.ts'
export {
  resolveSourceAuth,
  resolveSourceAuths,
  gitAuthArgs,
  DEFAULT_USERNAME,
  type SourceAuthOptions,
} from './source-auth.ts'
// The credentials SERVICE DEFINITION (the contract, no provider vocabulary).
// The core ships NO provider - every provider is a PLUGIN (the public plugins
// repo's `credentials-basic` is the default set). A provider implements the
// definition; a consumer uses the definition. Neither may import the other:
// `npm run check:seam` enforces the direction Provider -> Definition <- Consumer.
export * from './credentials/definition.ts'
// The WEB capability lives ENTIRELY in the EXTERNAL plugins repository
// (`nexuslbs/workbench-plugins`): `definitions/web.ts` is the `web@1`
// Definition and `plugins/web-impl` provides the HTTP server. The core ships no
// web module and NO LISTENER - it LOADS the provider plugin, DEFERS the `web:`
// section until one is loaded and registers only its two own routes (/health,
// /api/plugins) on the seam that plugin provided. The seam is published as a
// TYPE-ONLY structural view an external provider satisfies.
export type { WebRequest, WebResponse, WebRouteInfo, WebRouteSpec, WebSeam } from './web-seam.ts'
export * from './types.ts'

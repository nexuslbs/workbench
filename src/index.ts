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
  githubAppJwt,
  githubAppInstallationToken,
  gitAuthArgs,
  clearInstallationTokenCache,
  DEFAULT_API_BASE,
  TOKEN_SKEW_MS,
  type SourceAuthOptions,
  type GitHubAppTokenOptions,
} from './source-auth.ts'
export {
  bootstrapCredentials,
  bootstrapProviders,
  coreProviderIds,
  BootstrapCredentials,
  type BootstrapOptions,
} from './credentials/providers/bootstrap.ts'
// The credentials SERVICE DEFINITION (the contract, no provider vocabulary) and
// the core PROVIDERS that ship with the core. An external provider implements
// the definition; a consumer uses the definition. Neither may import the other:
// `npm run check:seam` enforces the direction Provider -> Definition <- Consumer.
export * from './credentials/definition.ts'
export { CORE_PROVIDERS, CORE_PROVIDER_IDS, registerCoreProviders, type CoreProvider } from './credentials/providers/index.ts'
// The EMAIL capability DEFINITION (`email@1`): the contract an email PROVIDER
// plugin implements (accounts/list/get/code/search over account REFERENCES,
// never an address and never a value) and a CONSUMER (the email tools, a UI)
// calls as `ctx.email`. Same three-role seam as credentials and web:
// Provider -> Definition <- Consumer, enforced by `npm run check:seam`.
export * from './email/definition.ts'
// The TOTP capability DEFINITION (`totp@1`): the contract a totp PROVIDER plugin
// implements (entries() as metadata only, code(label, { at }) for the current
// code) and a CONSUMER (the totp tools, a UI) calls as `ctx.totp`. Same
// three-role seam as credentials, web and email:
// Provider -> Definition <- Consumer, enforced by `npm run check:seam`.
export * from './totp/definition.ts'
// The SMS capability DEFINITION (`sms@1`): the contract an sms PROVIDER plugin
// implements (numbers() as label/metadata only, list()/get() over NUMBER
// REFERENCES, code() extraction) and a CONSUMER (the sms tools, a UI) calls as
// `ctx.sms`. Same three-role seam as credentials, web, email and totp:
// Provider -> Definition <- Consumer, enforced by `npm run check:seam`.
export * from './sms/definition.ts'
// The TOOLS capability: the definition (what a consumer plugin registers a named
// tool with: name, description, parameter schema, handler) and the core HTTP
// seam that exposes the registry by name (`POST /api/tools/<name>`).
export * from './tools/definition.ts'
export { registerToolRoutes, type ToolSource } from './tools/http.ts'
// The WEB seam: the definition (what a UI plugin registers routes, assets and
// pages with) plus the core `node:http` provider the composition root wires.
export * from './web/definition.ts'
export { createWebServer, MAX_BODY_BYTES, type WebServer, type WebServerOptions } from './web/providers/http.ts'
export * from './types.ts'

import path from 'node:path'
import { Context } from 'cordis'
import { expandCredentialRefsDeep, findDefaultConfigFile, readConfig } from './config.ts'
import { Credentials, CREDENTIALS, CREDENTIALS_VERSION, type CredentialRef, type CredentialsService } from './credentials/definition.ts'
import { CORE_PROVIDERS, registerCoreProviders } from './credentials/providers/index.ts'
import { loadPlugins, type LoadFailure, type PluginDiscovery, type SourceReport } from './loader.ts'
import { CommandRegistry } from './registry.ts'
import type { LoadedPlugin, WorkbenchConfig } from './types.ts'

export interface KernelOptions {
  /** Config file to load (default: the first default config file in the working directory). */
  configFile?: string
  /** Pre-loaded config (used by tests instead of a file). */
  config?: WorkbenchConfig
  /** Directory relative source paths resolve against (default: the config file directory). */
  configDir?: string
  /** Directory git sources are checked out into (default: $WORKBENCH_CACHE_DIR or `<config dir>/.workbench/sources`). */
  cacheDir?: string
  /** Set false to skip external sources (`--no-external`). */
  includeExternal?: boolean
  /** Log sink; defaults to stderr so command output stays clean on stdout. */
  log?: (message: string) => void
}

export interface Kernel {
  ctx: Context
  registry: CommandRegistry
  /**
   * The credentials capability: what consumers call (`resolve`/`explain`/`list`)
   * and what provider plugins register with (`register`). Also reachable as
   * `ctx.credentials` from any plugin (inject: ['credentials']).
   */
  credentials: CredentialsService
  /** Config file the kernel was booted from (the resolved path, or a marker for an inline config). */
  configFile: string
  plugins: LoadedPlugin[]
  failures: LoadFailure[]
  sources: SourceReport[]
  dispose(): Promise<void>
}

/** True when a discovered plugin claims a credential provider id. */
function declaresCredentialProvider(discovery: PluginDiscovery): boolean {
  return discovery.capabilities.some((capability) => capability.id === CREDENTIALS && capability.provider !== undefined)
}

/**
 * Boots the workbench kernel: create the cordis root context, provide the
 * workbench service and the credentials SERVICE, declare every provider (the
 * four core ones plus whatever plugin manifests claim), fix the enabled
 * providers from configuration, load the plugins, then resolve the credential
 * references of the config through the service (a CONSUMER: it never touches a
 * provider).
 *
 * The load happens in two phases so that provider plugins are up BEFORE the
 * config's `${cred:NAME}` references are resolved, while the rest of the plugins
 * receive the already expanded config. Nothing here knows a provider id.
 */
export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const cwd = process.cwd()
  let config: WorkbenchConfig
  let configDir: string
  let configFile: string

  if (options.config) {
    config = options.config
    configDir = options.configDir ?? cwd
    configFile = options.configFile ?? '(inline config)'
  } else {
    const file = options.configFile ?? findDefaultConfigFile([cwd])
    const loaded = readConfig(file)
    config = loaded.config
    configDir = options.configDir ?? loaded.dir
    configFile = loaded.file
  }

  const log = options.log ?? ((message: string) => console.error(`[workbench] ${message}`))
  const registry = new CommandRegistry(log)
  const ctx = new Context()
  await ctx.plugin({ name: 'workbench', apply: (c) => { c.provide('workbench', registry) } })

  // The credentials service: the definition's default implementation plus the
  // DECLARATIONS of the core providers (they are core modules, not plugins of a
  // source, so the kernel declares them; their registrations follow).
  let credentials!: CredentialsService
  await ctx.plugin({
    name: CREDENTIALS,
    apply: (c) => {
      credentials = new Credentials(c)
      for (const provider of CORE_PROVIDERS) {
        credentials.declare({
          provider: provider.id,
          version: CREDENTIALS_VERSION,
          plugin: 'workbench-core',
          source: 'core',
          external: false,
        })
      }
      registerCoreProviders(c as Context & { credentials: CredentialsService }, config.plugins, configDir)
    },
  })

  const cacheDir = options.cacheDir ?? process.env.WORKBENCH_CACHE_DIR?.trim() ?? ''
  const loadOptions = {
    config,
    configDir,
    cacheDir: cacheDir.length > 0 ? cacheDir : path.join(configDir, '.workbench', 'sources'),
    includeExternal: options.includeExternal !== false,
    log,
    declare: (discovery: PluginDiscovery): void => {
      for (const capability of discovery.capabilities) {
        if (capability.id !== CREDENTIALS || capability.provider === undefined) continue
        credentials.declare({
          provider: capability.provider,
          version: capability.version ?? CREDENTIALS_VERSION,
          plugin: discovery.name,
          source: discovery.source,
          external: discovery.external,
        })
      }
    },
  }

  // Phase 1: the plugins that PROVIDE the capability (core modules are already
  // in), so that both the selection below and the config references can see them.
  const providers = await loadPlugins(ctx, { ...loadOptions, filter: declaresCredentialProvider })
  // Provider selection and precedence: CONFIGURATION only, never code.
  credentials.setEnabled(config.credentials?.providers)

  // The config loader consumes the capability: `${cred:NAME}` / `${secret:NAME}`.
  const expansionOptions = config.credentials?.scope === undefined ? {} : { scope: config.credentials.scope }
  const expanded = (await expandCredentialRefsDeep(
    { sources: config.sources, plugins: config.plugins ?? {} },
    { resolve: (ref: CredentialRef) => credentials.resolve(ref), enabled: () => credentials.enabled() },
    expansionOptions,
  )) as { sources: WorkbenchConfig['sources']; plugins: Record<string, Record<string, unknown>> }
  const effective: WorkbenchConfig = { ...config, sources: expanded.sources, plugins: expanded.plugins }

  // Phase 2: every other plugin, with the expanded config.
  const rest = await loadPlugins(ctx, { ...loadOptions, config: effective, filter: (discovery) => !declaresCredentialProvider(discovery) })

  const plugins: LoadedPlugin[] = [...providers.plugins, ...rest.plugins]
  const counts = new Map<string, number>()
  for (const plugin of plugins) counts.set(plugin.source, (counts.get(plugin.source) ?? 0) + 1)
  const sources: SourceReport[] = rest.sources.map((source) => ({ ...source, plugins: counts.get(source.id) ?? 0 }))
  registry.setPlugins(plugins)

  return {
    ctx,
    registry,
    credentials,
    configFile,
    plugins,
    failures: [...providers.failures, ...rest.failures],
    sources,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

import path from 'node:path'
import { Context } from 'cordis'
import { expandCredentialRefsDeep, findDefaultConfigFile, readConfig } from './config.ts'
import { readRawConfig, updateConfigFile } from './configfile.ts'
import { Credentials, CREDENTIALS, CREDENTIALS_VERSION, type CredentialRef, type CredentialsService } from './credentials/definition.ts'
import { CORE_PROVIDERS, registerCoreProviders } from './credentials/providers/index.ts'
import { bootstrapCredentials } from './credentials/providers/bootstrap.ts'
import { EMAIL, EMAIL_VERSION, Email, type EmailService } from './email/definition.ts'
import { Host } from './host.ts'
import { loadPlugins, type LoadFailure, type PluginDiscovery, type SourceReport } from './loader.ts'
import { resolveSourceAuths } from './source-auth.ts'
import { CommandRegistry } from './registry.ts'
import { registerToolRoutes } from './tools/http.ts'
import { WEB, DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, Web, type WebHandler } from './web/definition.ts'
import { createWebServer, type WebServer } from './web/providers/http.ts'
import type { ConfigApi, LoadedPlugin, Workbench, WorkbenchConfig } from './types.ts'

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

/** Options of {@link Kernel.startWeb}: the serve/loader seam, no product feature. */
export interface StartWebOptions {
  /** Bind host (default 127.0.0.1 - the UI has no auth in this round). */
  host?: string
  /** Bind port (default 12348; `0` picks a free port). */
  port?: number
  /**
   * Handler the web provider calls when the seam does not answer (before its
   * 404), so `serve` can keep its status endpoint on the same listener as the
   * UI. Passing one does not change any seam registration.
   */
  fallback?: WebHandler
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
  /**
   * The WEB capability (`ctx.web`): the seam UI plugins register routes, assets
   * and pages with. The kernel provides the service; {@link Kernel.startWeb}
   * starts the core `node:http` provider for it.
   */
  web: Web
  /**
   * The EMAIL capability (`email@1`): what consumers call (`accounts`, `list`,
   * `get`, `code`, `search`) and what provider plugins register with
   * (`register`). Also reachable as `ctx.email` from any plugin
   * (inject: ['email']).
   */
  email: EmailService
  /**
   * The host (loader) API: the live plugin set and every mutation of it
   * (load/unload/reload/retry/enable/disable/install/uninstall). Also reachable
   * as `ctx.workbench.host()` from any plugin.
   */
  host: Host
  /** Config file the kernel was booted from (the resolved path, or a marker for an inline config). */
  configFile: string
  /** The config as written (re-read from the file when the host has one). */
  readonly config: WorkbenchConfig
  /** Loaded plugins, live from the host (a getter: it follows host actions). */
  readonly plugins: LoadedPlugin[]
  /** Load failures, live from the host. */
  readonly failures: LoadFailure[]
  /** Configured sources, live from the host. */
  readonly sources: SourceReport[]
  /** Starts the core web provider for {@link Kernel.web}; close it with {@link Kernel.dispose}. */
  startWeb(options?: StartWebOptions): Promise<WebServer>
  /** The web server started by {@link Kernel.startWeb}, when one is running. */
  readonly webServer: WebServer | undefined
  dispose(): Promise<void>
}

/** True when a discovered plugin claims a credential provider id. */
function declaresCredentialProvider(discovery: PluginDiscovery): boolean {
  return discovery.capabilities.some((capability) => capability.id === CREDENTIALS && capability.provider !== undefined)
}

/** True when a discovered plugin claims an EMAIL provider id (capability `email`). */
function declaresEmailProvider(discovery: PluginDiscovery): boolean {
  return discovery.capabilities.some((capability) => capability.id === EMAIL && capability.provider !== undefined)
}

/**
 * Boots the workbench kernel: create the cordis root context, provide the
 * workbench service, the WEB seam and the credentials SERVICE, declare every
 * provider (the four core ones plus whatever plugin manifests claim), fix the
 * enabled providers from configuration, load the plugins, then resolve the
 * credential references of the config through the service (a CONSUMER: it never
 * touches a provider).
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

  // The WEB seam (the definition): the kernel provides the service, so a UI
  // plugin can register routes/assets/pages from any source. No socket here -
  // that is the provider's job, started by `startWeb`.
  let web!: Web
  await ctx.plugin({ name: WEB, apply: (c) => { web = new Web(c) } })

  // The EMAIL capability seam (the definition): the service exists as soon as
  // the kernel boots, so a provider plugin can register with it and a consumer
  // plugin can call `ctx.email`. No backend, no mailbox and no socket here - a
  // provider is a plugin from any source, selected by configuration.
  let email!: EmailService
  await ctx.plugin({ name: EMAIL, apply: (c) => { email = new Email(c) } })

  // The by-name TOOL INVOCATION surface: the registered tools belong to the
  // plugins, the routes are the core's contract for them. Registered here (the
  // composition root) so a caller can discover and invoke tools through the web
  // seam; the dispatch reads the live registry, so it follows load/unload.
  registerToolRoutes(web, registry)

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
  const expansionOptions = config.credentials?.scope === undefined ? {} : { scope: config.credentials.scope }
  const resolver = { resolve: (ref: CredentialRef) => credentials.resolve(ref), enabled: () => credentials.enabled() }

  // BOOTSTRAP credential set: the providers usable BEFORE any plugin is loaded.
  // A `git` source is fetched before plugin discovery, so a source credential
  // cannot come from a plugin-provided credentials provider (that provider is
  // itself discovered in a source). Same definition, no cordis, no plugin.
  const bootstrapFor = (raw: WorkbenchConfig) =>
    bootstrapCredentials({ configDir, providers: raw.credentials?.bootstrap, plugins: raw.plugins ?? {} })
  const sourceAuthResolver = (raw: WorkbenchConfig) =>
    resolveSourceAuths(raw, { configDir, credentials: bootstrapFor(raw) })
  // Resolved BEFORE the host exists and before the first source walk: this is
  // what makes a private source fetchable with no plugin loaded.
  const sourceAuth = await sourceAuthResolver(config)

  // The HOST: the live plugin set and the single mutation path. It exists before
  // the plugins load so `ctx.workbench.host()` / `.inventory()` already work
  // while a plugin is being applied.
  // Manifest capability declarations reach the capability services (credentials
  // and email) through this ONE callback. It must be handed to BOTH the host (a UI-driven load) and the
  // boot-time load below: the loader calls it right before a plugin is applied,
  // and without it a plugin that provides a capability would register in an
  // UNDECLARED state and fail its own apply (docs/PLUGIN-CONTRACT.md, rule 6).
  const declarePluginCapabilities = (discovery: PluginDiscovery): void => {
    for (const capability of discovery.capabilities) {
      if (capability.provider === undefined) continue
      if (capability.id === CREDENTIALS) {
        credentials.declare({
          provider: capability.provider,
          version: capability.version ?? CREDENTIALS_VERSION,
          plugin: discovery.name,
          source: discovery.source,
          external: discovery.external,
        })
        continue
      }
      if (capability.id === EMAIL) {
        email.declare({
          provider: capability.provider,
          version: capability.version ?? EMAIL_VERSION,
          plugin: discovery.name,
          source: discovery.source,
          external: discovery.external,
        })
      }
    }
  }

  const host = new Host({
    ctx,
    log,
    configFile,
    configDir,
    cacheDir: cacheDir.length > 0 ? cacheDir : path.join(configDir, '.workbench', 'sources'),
    includeExternal: options.includeExternal !== false,
    config,
    sourceAuth,
    sourceAuthResolver,
    declare: declarePluginCapabilities,
    pluginConfig: async (name, raw) => {
      const expanded = (await expandCredentialRefsDeep(raw, resolver, expansionOptions)) as Record<string, unknown>
      void name
      return expanded ?? {}
    },
  })

  // The config seam (Settings / Plugin Settings): view / edit / persist the
  // active config file plus the per-plugin config as written (references BY
  // NAME - this never resolves a credential).
  const configApi: ConfigApi = {
    file: () => host.configFilePath() ?? configFile,
    view: () => {
      const file = host.configFilePath()
      if (file === undefined) throw new Error('the kernel runs on an inline config: there is no config file to view')
      return readRawConfig(file)
    },
    update: (patch) => {
      const file = host.configFilePath()
      if (file === undefined) throw new Error('the kernel runs on an inline config: there is no config file to update')
      const view = updateConfigFile(file, patch)
      host.reloadConfig()
      return view
    },
    pluginConfig: (name) => host.pluginConfigView(name),
  }

  // The core service object: the command registry (what plugins register with)
  // plus the read/mutate surfaces the UI consumes. It is one object because a
  // plugin reaches the core through `ctx.workbench` alone.
  Object.assign(registry, {
    inventory: () => host.inventory(),
    host: () => host,
    config: () => configApi,
  })
  const workbench = registry as unknown as CommandRegistry & Workbench
  void workbench

  const loadOptions = {
    config,
    configDir,
    cacheDir: host.options.cacheDir,
    includeExternal: options.includeExternal !== false,
    sourceAuth,
    log,
    // Same declaration step as the host: a plugin that declares a capability in
    // its manifest is declared BEFORE it is applied, on every load path.
    declare: declarePluginCapabilities,
  }

  // Phase 1: the plugins that PROVIDE a capability (core modules are already
  // in), so that both the selection below and the config references can see them.
  const providers = await loadPlugins(ctx, {
    ...loadOptions,
    filter: (discovery) => declaresCredentialProvider(discovery) || declaresEmailProvider(discovery),
  })
  // Provider selection and precedence: CONFIGURATION only, never code.
  credentials.setEnabled(config.credentials?.providers)
  email.setEnabled(config.email?.providers)

  // The config loader consumes the capability: `${cred:NAME}`.
  const expanded = (await expandCredentialRefsDeep(
    { sources: config.sources, plugins: config.plugins ?? {} },
    resolver,
    expansionOptions,
  )) as { sources: WorkbenchConfig['sources']; plugins: Record<string, Record<string, unknown>> }
  const effective: WorkbenchConfig = { ...config, sources: expanded.sources, plugins: expanded.plugins }

  // Phase 2: every other plugin, with the expanded config.
  const rest = await loadPlugins(ctx, {
    ...loadOptions,
    config: effective,
    // A capability-providing plugin was already applied in phase 1; applying it
    // again would make its registration fail as a duplicate.
    filter: (discovery) => !declaresCredentialProvider(discovery) && !declaresEmailProvider(discovery),
  })

  const plugins: LoadedPlugin[] = [...providers.plugins, ...rest.plugins]
  const counts = new Map<string, number>()
  for (const plugin of plugins) counts.set(plugin.source, (counts.get(plugin.source) ?? 0) + 1)
  const sources: SourceReport[] = rest.sources.map((source) => ({ ...source, plugins: counts.get(source.id) ?? 0 }))
  registry.setPlugins(plugins)

  const fibers = new Map(providers.fibers)
  for (const [name, fiber] of rest.fibers) fibers.set(name, fiber)
  const discoveries = new Map<string, PluginDiscovery>()
  for (const discovery of [...providers.discoveries, ...rest.discoveries]) discoveries.set(discovery.name, discovery)
  host.adopt({
    config: effective,
    sources,
    discoveries: [...discoveries.values()],
    plugins,
    failures: [...providers.failures, ...rest.failures],
    fibers,
    disabled: [...new Set([...providers.disabled, ...rest.disabled])],
  })

  let webServer: WebServer | undefined

  return {
    ctx,
    registry,
    credentials,
    web,
    email,
    host,
    configFile,
    get config(): WorkbenchConfig {
      return host.rawConfig()
    },
    get plugins(): LoadedPlugin[] {
      return host.inventory().plugins
    },
    get failures(): LoadFailure[] {
      return host.inventory().failures
    },
    get sources(): SourceReport[] {
      return host.inventory().sources
    },
    async startWeb(start: StartWebOptions = {}): Promise<WebServer> {
      if (webServer) return webServer
      webServer = await createWebServer(web, {
        host: start.host ?? DEFAULT_WEB_HOST,
        port: start.port ?? DEFAULT_WEB_PORT,
        log,
        ...(start.fallback ? { fallback: start.fallback } : {}),
      })
      return webServer
    },
    get webServer(): WebServer | undefined {
      return webServer
    },
    dispose: async () => {
      if (webServer) {
        await webServer.close()
        webServer = undefined
      }
      await ctx.fiber.dispose()
    },
  }
}

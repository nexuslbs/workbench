import path from 'node:path'
import { Context } from 'cordis'
import { expandCredentialRefsDeep, findDefaultConfigFile, readConfig } from './config.ts'
import { readRawConfig, updateConfigFile } from './configfile.ts'
import { Credentials, CREDENTIALS, CREDENTIALS_VERSION, type CredentialRef, type CredentialsService } from './credentials/definition.ts'
import { Host } from './host.ts'
import { loadPlugins, type LoadFailure, type PluginDiscovery, type SourceReport } from './loader.ts'
import { resolveSourceAuths } from './source-auth.ts'
import { sourceId, type SourceAuthOutcome } from './sources.ts'
import { CommandRegistry } from './registry.ts'
// The core's OWN routes on the web seam (the loader status, the inventory). The
// seam is declared STRUCTURALLY in `./web-seam.ts` (type-only) on purpose: the
// `web@1` Definition lives in the EXTERNAL plugins repository and the core must
// not import it. The server itself is a PROVIDER PLUGIN, so the core binds no
// port and owns no route beyond these two.
import type { WebRequest, WebResponse, WebSeam } from './web-seam.ts'
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

/** The capability id of the web seam (`web@1`); its Definition lives in the plugins repository. */
export const WEB = 'web'

/**
 * The state of the WEB capability (`web@1`) in this deployment.
 *
 * The core ships NO web provider: an enabled `web:` section IMPLICITLY DEPENDS
 * on a plugin providing the seam (`web-impl` in the external plugins
 * repository). Without one the section is DEFERRED - structured state, a loud
 * log line, no crash, no silent skip - and it becomes eligible the moment such a
 * plugin is loaded.
 */
export interface WebState {
  /** `served`: a provider plugin is loaded; `deferred`: asked for but unserved; `off`: not asked for. */
  state: 'served' | 'deferred' | 'off'
  /** True when the config asks for the Web UI (`web.enabled: true`). */
  enabled: boolean
  /** The plugin that serves the seam (`served` only). */
  plugin?: string
  /** Its provider id, e.g. `http` (`served` only). */
  provider?: string
  /** The source that plugin came from (`served` only). */
  source?: string
  /** Whether that source is external (`served` only). */
  external?: boolean
  /** Why the section is not served (`deferred` only). */
  reason?: string
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
   * The state of the WEB capability (`web@1`): the seam AND its listener come
   * from a PROVIDER PLUGIN (external repository). The core only reports whether
   * the deployment is served, deferred (asked for, no provider loaded) or off.
   */
  webState: WebState
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
  dispose(): Promise<void>
}

/** True when a discovered plugin claims a credential provider id. */
function declaresCredentialProvider(discovery: PluginDiscovery): boolean {
  return discovery.capabilities.some((capability) => capability.id === CREDENTIALS && capability.provider !== undefined)
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

  // The WEB capability lives ENTIRELY in the EXTERNAL plugins repository: the
  // `web@1` Definition AND the server providers (`web-impl`). The core hosts no
  // seam and no listener; it registers its OWN routes on the seam once a provider
  // plugin has provided it (see `registerCoreRoutes` called after the plugins
  // load), so the plugin-less core still ANSWERS instead of 404ing without owning
  // any web code. With no provider loaded the seam never exists, nothing is
  // registered, and {@link Kernel.webState} reports the DEFERRED state loudly.
  const statusPayload = (): string =>
    JSON.stringify(
      {
        status: 'ok',
        configFile,
        plugins: host.inventory().plugins,
        sources: host.inventory().sources,
        failures: host.inventory().failures,
      },
      null,
      2,
    )
  const statusHandler = (request: WebRequest): WebResponse | undefined => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
    if (request.path !== '/health' && request.path !== '/healthz') return undefined
    return { contentType: 'application/json; charset=utf-8', body: statusPayload() + '\n' }
  }
  const pluginsHandler = (request: WebRequest): WebResponse | undefined => {
    if (request.method !== 'GET') return undefined
    const inventory = host.inventory()
    return {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(
        {
          plugins: inventory.plugins,
          discovered: inventory.discovered,
          available: inventory.available,
          failures: inventory.failures,
          sources: inventory.sources,
        },
        null,
        2,
      ) + '\n',
    }
  }

  /**
   * Registers the core's OWN routes on the seam: the loader status endpoint the
   * deployment healthchecks probe and the loader inventory. Called ONLY when a
   * `web@1` provider plugin provided `ctx.web`; the handlers read the live host,
   * so they follow load/unload/reload. The core owns no other route: the tool
   * dispatch (`/api/tools*`) is served by the external `tools-impl` plugin.
   */
  const registerCoreRoutes = (web: WebSeam): void => {
    // `/health` belongs to the LISTENER owner: the real provider plugin
    // (`web-impl`) registers its own `/health` - the `web@1` contract plus the live
    // inventory - BEFORE the core gets here, and the seam throws on a duplicate
    // method+path, which would abort the whole boot (found by the CI replay of
    // task 2486). So the core registers its status route only when the seam does
    // not answer that method+path yet: it is the FALLBACK for a provider that
    // serves the seam without a health route.
    const answered = (method: string, path: string): boolean =>
      (web.routes?.() ?? []).some((route) => route.method === method && route.path === path)
    if (!answered('GET', '/health')) {
      web.route({ method: 'GET', path: '/health', handler: statusHandler, description: 'the loader status (core)' })
    }
    if (!answered('HEAD', '/health')) {
      web.route({ method: 'HEAD', path: '/health', handler: statusHandler, description: 'the loader status (core)' })
    }
    web.route({
      method: 'GET',
      path: '/api/plugins',
      description: 'the loader inventory (core): an EMPTY list is a valid answer',
      handler: pluginsHandler,
    })
  }

  // The credentials service: the DEFINITION's own implementation (the routing
  // walk, no backend) and NOTHING else. The core declares and registers NO
  // provider - no env, no file, no store, no resolver - because a provider is a
  // plugin from a source (operator rule 2026-09-19). Only after such a plugin is
  // loaded may a `${cred:...}` source or plugin be resolved (the gate below).
  let credentials!: CredentialsService
  await ctx.plugin({
    name: CREDENTIALS,
    apply: (c) => {
      credentials = new Credentials(c)
    },
  })

  const cacheDir = options.cacheDir ?? process.env.WORKBENCH_CACHE_DIR?.trim() ?? ''
  const expansionOptions = config.credentials?.scope === undefined ? {} : { scope: config.credentials.scope }
  const resolver = { resolve: (ref: CredentialRef) => credentials.resolve(ref), enabled: () => credentials.enabled() }

  // ---------------------------------------------------------------------------
  // `${cred:...}` GATING (operator rule, 2026-09-19): an entry whose config needs
  // a credential IMPLICITLY DEPENDS on a plugin implementing the credentials@1
  // service definition. The core ships NO credential provider, so such an entry
  // is DEFERRED until a provider plugin has been loaded - from a source that
  // needs no credential. That is what breaks the bootstrap chicken-and-egg: the
  // provider implementation lives in the PUBLIC plugins repo, is fetchable from
  // a remote source WITHOUT credentials, and only then do the `${cred:...}`
  // sources and plugins become loadable. A missing/invalid credential of an
  // ALREADY loaded provider is still a loud error (never a silent skip).
  // ---------------------------------------------------------------------------
  const needsCredential = (raw: unknown): boolean => {
    const record = (raw ?? {}) as { auth?: unknown }
    if (record.auth !== undefined) return true
    return JSON.stringify(raw ?? null).includes('${cred:')
  }
  const gatedSources = config.sources.filter(needsCredential)
  const openSources = config.sources.filter((source) => !needsCredential(source))
  const hasProvider = (): boolean => credentials.providers().some((provider) => provider.registered)
  const logDeferral = (id: string): void =>
    log(
      `[workbench] source '${id}' is DEFERRED: its config needs a credential (${'${cred:...}'} / auth) but no plugin ` +
        `implementing credentials@1 is loaded yet; load a credentials provider plugin (credentials-basic) from a ` +
        `source that needs no credential and the source becomes eligible`,
    )
  const deferredSourceReports: SourceReport[] = []
  // The source auth map is FILLED in two steps: the sources that need no
  // credential are walked first (that is where the provider plugin comes from),
  // then, only when a provider is registered, the credential-dependent ones.
  const sourceAuth = new Map<string, SourceAuthOutcome>()
  // Re-resolution used by the host after a config change (Settings/install): the
  // LIVE credentials service, and ONLY once a provider plugin is registered - the
  // same gate as the boot path. With no provider the map stays EMPTY and a
  // credential-dependent source is reported LOUDLY by the loader (never a silent
  // anonymous retry).
  const sourceAuthResolver = (raw: WorkbenchConfig): Promise<ReadonlyMap<string, SourceAuthOutcome>> =>
    hasProvider()
      ? resolveSourceAuths(raw, { configDir, credentials })
      : Promise.resolve(new Map<string, SourceAuthOutcome>())

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

  // Phase 1: the plugins that PROVIDE the credentials capability, from the
  // sources that need no credential (the core ships no provider module).
  const providers = await loadPlugins(ctx, {
    ...loadOptions,
    config: { ...config, sources: openSources },
    filter: (discovery) => declaresCredentialProvider(discovery),
  })

  // THE GATE: resolve the credential-dependent sources through the LIVE
  // credentials service, and only once a provider plugin is registered. With no
  // provider plugin the entry is DEFERRED (structured log + source report), it
  // is NOT a failure and NOT a silent skip, and the core keeps serving.
  const gatedReady = gatedSources.length > 0 && hasProvider()
  if (gatedSources.length > 0 && gatedReady) {
    const auths = await resolveSourceAuths({ ...config, sources: gatedSources }, { configDir, credentials })
    for (const [id, outcome] of auths) sourceAuth.set(id, outcome)
  } else if (gatedSources.length > 0) {
    for (const source of gatedSources) {
      const id = sourceId(source, configDir)
      logDeferral(id)
      deferredSourceReports.push({
        id,
        kind: source.kind,
        dir: null,
        external: source.external !== false,
        plugins: 0,
        error: 'deferred: the config needs a credential but no plugin implementing credentials@1 is loaded',
      })
    }
  }
  // Provider selection and precedence: CONFIGURATION only, never code.
  if (hasProvider()) credentials.setEnabled(config.credentials?.providers)
  const activeSources = gatedReady ? [...openSources, ...gatedSources] : openSources

  // The config loader consumes the capability: `${cred:NAME}`.
  // Plugin-level gating: a `plugins.<name>` row whose config uses a credential
  // reference has the SAME implicit dependency as a source. With no provider
  // plugin loaded the row is DEFERRED: it is kept out of the roster (so the
  // plugin stays AVAILABLE, not loaded), the deferral is LOGGED, and nothing
  // crashes - never a silent skip.
  const refToken = '$' + '{cred:'
  const gatedPluginNames = hasProvider()
    ? []
    : Object.entries(config.plugins ?? {})
        .filter(([, raw]) => JSON.stringify(raw ?? null).includes(refToken))
        .map(([name]) => name)
  const roster: Record<string, Record<string, unknown>> = { ...(config.plugins ?? {}) }
  for (const name of gatedPluginNames) {
    delete roster[name]
    log(
      `[workbench] plugin '${name}' is DEFERRED: its config needs a credential (` + refToken + `...) but no plugin ` +
        `implementing credentials@1 is loaded yet; load a credentials provider plugin and the plugin becomes eligible`,
    )
  }
  const expanded = (await expandCredentialRefsDeep(
    { sources: activeSources, plugins: roster },
    resolver,
    expansionOptions,
  )) as { sources: WorkbenchConfig['sources']; plugins: Record<string, Record<string, unknown>> }
  const effective: WorkbenchConfig = { ...config, sources: expanded.sources, plugins: expanded.plugins }

  // Phase 2: every other plugin, with the expanded config.
  const rest = await loadPlugins(ctx, {
    ...loadOptions,
    config: effective,
    // A credentials-providing plugin was already applied in phase 1; applying it
    // again would make its registration fail as a duplicate.
    filter: (discovery) => !declaresCredentialProvider(discovery),
  })

  const plugins: LoadedPlugin[] = [...providers.plugins, ...rest.plugins]
  const counts = new Map<string, number>()
  for (const plugin of plugins) counts.set(plugin.source, (counts.get(plugin.source) ?? 0) + 1)
  const sources: SourceReport[] = [
    ...rest.sources.map((source) => ({ ...source, plugins: counts.get(source.id) ?? 0 })),
    ...deferredSourceReports,
  ]
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

  // ---------------------------------------------------------------------------
  // THE WEB GATE (operator rule, 2026-09-19): the core ships NO web provider - the
  // `web@1` Definition AND the server providers live in the EXTERNAL plugins
  // repository. An enabled `web:` section therefore IMPLICITLY DEPENDS on a plugin
  // providing the seam. Without one the section is DEFERRED: a structured state,
  // a loud log line, no crash, no silent skip - the core keeps running. It becomes
  // eligible the moment such a plugin is loaded: the seam appears as `ctx.web`,
  // the core routes below register, and the provider owns the listener (so
  // `workbench serve` leaves the port to it instead of binding it itself).
  // ---------------------------------------------------------------------------
  const webProvider = plugins
    .map((plugin) => ({
      plugin,
      capability: plugin.capabilityList.find((capability) => capability.id === WEB && capability.provider !== undefined),
    }))
    .find((entry) => entry.capability !== undefined)
  const webEnabled = config.web?.enabled === true
  const webSeam = (ctx as unknown as { web?: WebSeam }).web
  const webState: WebState = webProvider
    ? {
        state: 'served',
        enabled: webEnabled,
        plugin: webProvider.plugin.name,
        provider: webProvider.capability?.provider ?? '',
        source: webProvider.plugin.source,
        external: webProvider.plugin.external,
      }
    : webEnabled
      ? {
          state: 'deferred',
          enabled: true,
          reason:
            'no plugin providing web@1 is loaded: add a web provider plugin (web-impl) to the plugins: roster from the ' +
            'external source https://github.com/nexuslbs/workbench-plugins',
        }
      : { state: 'off', enabled: false }
  if (webState.state === 'deferred') log(`[workbench] web is DEFERRED: ${webState.reason}`)
  else if (webState.state === 'served') {
    log(
      `[workbench] web served by plugin '${webState.plugin}' (provider '${webState.provider}', ` +
        `${webState.external ? 'external:' : ''}${webState.source})`,
    )
  }

  // The core's own routes on the seam, registered only when a provider plugin
  // actually provided `ctx.web` (a deployment running the web provider).
  if (webSeam) registerCoreRoutes(webSeam)

  return {
    ctx,
    registry,
    credentials,
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
    webState,
    dispose: async () => {
      // The listener belongs to the provider PLUGIN: disposing the fiber tree runs
      // its effects, which close the server and unregister the seam and routes.
      await ctx.fiber.dispose()
    },
  }
}

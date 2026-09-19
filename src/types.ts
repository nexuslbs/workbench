import type { Context } from 'cordis'

/** Manifest file name, one per plugin directory. */
export const MANIFEST_FILE = 'workbench.plugin.json'

/**
 * A capability a plugin provides. Two forms are accepted in a manifest:
 *
 *   "capabilities": ["command:hello world"]                          // short form (unchanged)
 *   "capabilities": [{ "id": "credentials", "version": 1, "provider": "vault" }]
 *
 * The short form is equivalent to `{ id: '<string>' }`. The structured form is
 * the ADDITIVE extension the credentials seam uses: `id` is the capability id,
 * `version` the contract version the plugin implements and `provider` the
 * provider id the plugin registers with that capability (for capabilities that
 * are provided by several implementations). Manifests without the field keep
 * loading exactly as before.
 */
export type CapabilityDeclaration = {
  /** Capability id, e.g. `command:hello world` or `credentials`. */
  id: string
  /** Contract version of the capability the plugin implements. */
  version?: number
  /** Provider/implementation id, when the capability has several of them. */
  provider?: string
}

/** Capability as written in a manifest: the short string form or the structured form. */
export type Capability = string | CapabilityDeclaration

/** Shape of a plugin manifest (`workbench.plugin.json`). */
export interface PluginManifest {
  /** Unique plugin name. */
  name: string
  version: string
  description?: string
  /** Entry module, relative to the plugin directory (ESM). */
  entry: string
  /** Capabilities the plugin provides, e.g. `command:hello world`. */
  capabilities?: Capability[]
  /** JSON-schema-ish description of the plugin config. */
  config?: Record<string, unknown>
}

/** Renders a capability declaration for display (e.g. `credentials:vault@1`). */
export function renderCapability(capability: CapabilityDeclaration): string {
  if (capability.provider === undefined && capability.version === undefined) return capability.id
  const provider = capability.provider ? `:${capability.provider}` : ''
  const version = capability.version === undefined ? '' : `@${capability.version}`
  return `${capability.id}${provider}${version}`
}

/**
 * Validates and normalises manifest capabilities. The string short form stays
 * exactly what it was (`{ id }`); the structured form is the additive extension
 * credential providers declare. Throws a message naming the manifest.
 */
export function normalizeCapabilities(capabilities: Capability[] | undefined, where: string): CapabilityDeclaration[] {
  const result: CapabilityDeclaration[] = []
  for (const capability of capabilities ?? []) {
    if (typeof capability === 'string') {
      if (capability.length === 0) throw new Error(`${where}: a capability string must not be empty`)
      result.push({ id: capability })
      continue
    }
    if (capability === null || typeof capability !== 'object' || Array.isArray(capability)) {
      throw new Error(`${where}: every capability must be a string or a declaration object (got ${capability === null ? 'null' : Array.isArray(capability) ? 'array' : typeof capability})`)
    }
    const { id, version, provider } = capability as CapabilityDeclaration
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(`${where}: a capability declaration needs a non-empty 'id' string`)
    }
    if (version !== undefined && (typeof version !== 'number' || !Number.isInteger(version) || version <= 0)) {
      throw new Error(`${where}: capability '${id}' declares an invalid 'version' (expected a positive integer, got ${JSON.stringify(version)})`)
    }
    if (provider !== undefined && (typeof provider !== 'string' || provider.length === 0)) {
      throw new Error(`${where}: capability '${id}' declares an invalid 'provider' (expected a non-empty string, got ${JSON.stringify(provider)})`)
    }
    result.push({ id, ...(version === undefined ? {} : { version }), ...(provider === undefined ? {} : { provider }) })
  }
  return result
}

/** A command (capability) a plugin registers with the core. */
export interface CommandDefinition {
  /** Space separated command path, e.g. `hello world`. */
  name: string
  /** Runs the command and returns the text to print. */
  run: (args: string[]) => string | Promise<string>
  description?: string
  /** Plugin that registered the command (filled in by the core). */
  plugin?: string
}

/** A plugin loaded by the core. */
export interface LoadedPlugin {
  name: string
  version: string
  description?: string
  /** Rendered capabilities (display form, e.g. `command:hello world`). */
  capabilities: string[]
  /** The same capabilities, structured (what the core can act on). */
  capabilityList: CapabilityDeclaration[]
  /** Source id the plugin was discovered in (e.g. `core`, `workbench-plugins`). */
  source: string
  /** Absolute plugin directory. */
  dir: string
  /** True when the plugin came from a non-core (external) source. */
  external: boolean
}

/**
 * Authentication for a `git` source. The config carries a credential REFERENCE
 * (a name), never a value: the value is resolved at FETCH time through the
 * credentials service, by a PROVIDER PLUGIN (the core ships none) that the
 * kernel loaded from a credential-free source first. A source whose credential
 * has no provider yet is DEFERRED, and the value is used TRANSIENTLY - it is
 * never written into the checkout, the remote url or a log.
 */
export interface SourceAuthSpec {
  /**
   * Credential TYPE this reference resolves to. The core knows ONE built-in
   * value (`token`): the credential value IS the token. Every other type
   * (`github-app`, and any future backend) is a GIT AUTH STRATEGY a PLUGIN
   * registers with the credentials service
   * (`ctx.credentials.registerGitAuth(...)`, e.g. the external
   * `credentials-github-app` plugin): the core mints nothing itself. Without a
   * registered handler for the type the source is reported as an error naming
   * the type - never a silent anonymous fetch.
   */
  type?: string
  /** Credential reference BY NAME (`NAME` or `SCOPE/NAME`). Never a value. */
  credential: string
  /** `token`: username used in the basic auth header (default `x-access-token`). */
  username?: string
  /** Backend-specific field, read by the git auth handler of the type (e.g. the App id; never a secret). */
  appId?: number | string
  /** Backend-specific field, read by the git auth handler of the type (e.g. the installation id; never a secret). */
  installationId?: number | string
  /** Backend-specific field, read by the git auth handler of the type (e.g. the API base). */
  apiBase?: string
}

/** A plugin source (where the core discovers plugin directories). */
export interface SourceSpec {
  /** `path` = local directory; `git` = git coordinate. */
  kind: 'path' | 'git'
  /** Stable source id used in reports (defaults to the directory/repository name). */
  id?: string
  /** `path` sources: absolute path or path relative to the config file. */
  path?: string
  /** `git` sources: repository url. */
  url?: string
  /** `git` sources: branch/tag/commit. */
  ref?: string
  /** `git` sources: subdirectory of the repository holding the plugin directories. */
  subdir?: string
  /** Core sources set `external: false`; everything else is external (default true). */
  external?: boolean
  /**
   * `git` sources: authentication for a PRIVATE remote (a credential REFERENCE,
   * never a value). Omitted = anonymous fetch, exactly as before.
   */
  auth?: SourceAuthSpec
}

/**
 * The `credentials` section of the workbench config: PROVIDER SELECTION, the
 * only thing that decides which credentials providers answer and in what order.
 * Adding/swapping/disabling a provider is a config edit, never a code change.
 */
export interface CredentialsConfig {
  /**
   * Provider ids, in resolution (precedence) order. Only the listed providers
   * are ENABLED; a provider id that no plugin declares is a config error.
   * Omit (or leave empty) to enable every declared provider in declaration
   * order (core providers first: env, file, project-env, user-env).
   */
  providers?: string[]
  /** Default scope for `${cred:NAME}` references that do not carry one. */
  scope?: string
}

/** A plugin the loader could not load: reported, never fatal. */
export interface LoadFailure {
  plugin: string
  source: string
  error: string
}

/** A configured plugin source, as resolved and reported by the loader. */
export interface SourceReport {
  id: string
  kind: string
  dir: string | null
  external: boolean
  plugins: number
  error?: string
}

/**
 * Where a discovered plugin stands in the live host.
 *
 * - `loaded`: named in the `plugins:` roster and applied by the loader.
 * - `available`: discovered in a configured source but NOT on the roster (no
 *   `plugins.<name>` row) - installable with one `enable`, never imported.
 * - `disabled`: on the roster but parked (`disabled: true`) - not loaded, and
 *   deliberately NOT a failure.
 * - `failed`: named on the roster but the import/`apply()` threw.
 */
export type PluginState = 'loaded' | 'failed' | 'disabled' | 'available'

/** One discovered plugin, with its manifest facts and its live state. */
export interface PluginDiscoveryInfo {
  name: string
  version: string
  description?: string
  /** Absolute plugin directory. */
  dir: string
  /** Source id the plugin was discovered in. */
  source: string
  external: boolean
  /** Rendered capabilities (display form). */
  capabilities: string[]
  state: PluginState
  /** True when the config NAMES the plugin in the `plugins:` roster. */
  roster: boolean
  /** Load error, when `state` is `failed`. */
  error?: string
  /** Commands the plugin registered (only while loaded). */
  commands: string[]
}

/** A command registration, as reported by the inventory. */
export interface CommandInfo {
  name: string
  description?: string
  plugin?: string
}

/**
 * The loader inventory: the read path every consumer uses (`workbench plugins`,
 * the Plugin Inventory UI). It is built from the loader registry only - no
 * consumer scrapes files or config to rebuild it.
 */
export interface HostInventory {
  /** Config file the host was booted from (or `(inline config)`). */
  configFile: string
  /** Plugins that are loaded right now. */
  plugins: LoadedPlugin[]
  sources: SourceReport[]
  failures: LoadFailure[]
  /** Names of discovered plugins that are disabled in the config (parked). */
  disabled: string[]
  /** Names of discovered plugins that are NOT on the roster (`plugins:`). */
  available: string[]
  /** Every discovered plugin with its state (loaded, failed, disabled, available). */
  discovered: PluginDiscoveryInfo[]
  commands: CommandInfo[]
}

/** The actions the host (loader) API exposes. */
export type HostAction =
  | 'load'
  | 'unload'
  | 'reload'
  | 'enable'
  | 'disable'
  | 'retry'
  | 'install-source'
  | 'remove-source'
  | 'reconcile'

/** What a host action did, with the before/after inventory (the refresh). */
export interface HostActionResult {
  ok: boolean
  action: HostAction
  target: string
  /** The raw request that produced the action (no secret ever appears here). */
  request: Record<string, unknown>
  /** True when the change was persisted to the config file. */
  persisted: boolean
  before: HostInventory
  after: HostInventory
  message: string
}

/**
 * What `reconcile` did to ONE plugin of the DESIRED roster.
 *
 * - `load`: a desired row that was not loaded (or not loaded any more) is now,
 * - `unload`: the plugin was loaded and nothing desires it any more (the row was
 *   removed from the config, or it is parked),
 * - `reload`: the row's effective config changed, so the fiber was replaced,
 * - `unchanged`: desired and live state already agreed - no fiber churn,
 * - `deferred`: the row needs a credential but no plugin implementing the
 *   credentials service definition is loaded yet (structured, NOT an error),
 * - `error`: the row could not be applied (import/`apply()` threw, or the row
 *   config could not be resolved); the OTHER rows still converged.
 */
export type ReconcileAction = 'load' | 'unload' | 'reload' | 'unchanged' | 'deferred' | 'error'

/** One plugin of the desired-vs-live diff a reconcile applied. */
export interface ReconcileChange {
  /** The plugin name (the `plugins:` key). */
  name: string
  /** True when the config FILE names the plugin on the `plugins:` roster. */
  desired: boolean
  /** True when the plugin was loaded BEFORE this reconcile ran. */
  loaded: boolean
  action: ReconcileAction
  /** Why that action was chosen / what happened (never a secret value). */
  reason: string
  /** The failure message when `action` is `error`. */
  error?: string
}

/**
 * The report of a reconcile: the loader state before and after (like every other
 * action) PLUS the per-plugin delta and the source re-scan, so a consumer can
 * show exactly which plugin was loaded, unloaded or reloaded - and which one was
 * deferred or failed - instead of claiming a convergence.
 */
export interface HostReconcileReport extends HostActionResult {
  action: 'reconcile'
  /** One entry per desired row, plus every loaded plugin the diff unloaded. */
  changes: ReconcileChange[]
  /** Names the config desired but the credentials GATE deferred. */
  deferred: string[]
  /** Names whose application failed (the other rows still converged). */
  errors: string[]
  /** The sources as re-scanned by this reconcile (the `sources:` walk). */
  sources: SourceReport[]
  /** Plugins loaded after the reconcile. */
  loaded: number
}

/**
 * The host (loader) mutation API: install/enable/disable/retry/compose all go
 * through here, never through direct filesystem writes from a plugin. Every
 * action reports the loader state before and after, so a consumer can show the
 * effect instead of claiming it.
 */
export interface HostApi {
  inventory(): HostInventory
  canPersist(): { ok: boolean; reason?: string }
  load(name: string): Promise<HostActionResult>
  unload(name: string): Promise<HostActionResult>
  reload(name: string): Promise<HostActionResult>
  retry(name: string): Promise<HostActionResult>
  enable(name: string): Promise<HostActionResult>
  disable(name: string): Promise<HostActionResult>
  install(spec: SourceSpec): Promise<HostActionResult>
  uninstall(id: string): Promise<HostActionResult>
  /**
   * Applies a config-file edit to the RUNNING process in one operation: diff the
   * DESIRED `plugins:` roster against the live cordis tree and apply only the
   * delta (load / unload / reload), leaving every converged plugin untouched.
   */
  reconcile(): Promise<HostReconcileReport>
}

/** One edit of a config file (see {@link ConfigPatch} and the config seam). */
export type ConfigPatch =
  | { op: 'set'; path: (string | number)[]; value: unknown }
  | { op: 'delete'; path: (string | number)[] }
  | { op: 'append'; path: (string | number)[]; value: unknown }

/** What the config seam reports: the file as written, plus its parsed value. */
export interface RawConfigView {
  file: string
  /** True when the file is a real file (an inline config cannot be edited). */
  writable: boolean
  /** File text as written; `${env:VAR}` and `${cred:NAME}` stay by NAME. */
  text: string
  /** Parsed value with NO expansion applied. */
  value: unknown
}

/**
 * The config seam (Settings / Plugin Settings consume it): view the active
 * config file, edit a value and persist it, re-read it. Values are read
 * UNEXPANDED, so a secret reference is visible by NAME only - the seam never
 * resolves a credential and never returns a value.
 */
export interface ConfigApi {
  file(): string
  /** The active config file as written (references stay by name). */
  view(): RawConfigView
  /** Applies a patch to the config file, persists it and returns the new view. */
  update(patch: ConfigPatch[]): RawConfigView
  /** Per-plugin config as written: `${env:VAR}` and `${cred:NAME}` stay BY NAME. */
  pluginConfig(name: string): Record<string, unknown>
}

/** The workbench config file (`workbench.config.json`). */
export interface WorkbenchConfig {
  /** Where plugins are DISCOVERED: the available-plugins inventory. */
  sources: SourceSpec[]
  /**
   * The plugin ROSTER: only the plugins NAMED here are loaded (plus per-plugin
   * config, which is passed to `apply(ctx, config)` as-is; `{}` when the row is
   * empty). A discovered plugin without a row here is AVAILABLE, not loaded.
   * `disabled: true` inside a row parks it (roster row present, not loaded).
   */
  plugins?: Record<string, PluginConfig>
  /** Credentials provider selection/precedence (see {@link CredentialsConfig}). */
  credentials?: CredentialsConfig
  /** Web UI section (see {@link WebConfig}); absent keeps the historical behaviour. */
  web?: WebConfig
}

/**
 * The `web` section: whether the long-running `serve` entrypoint also starts
 * the web UI, and where it binds. Absent/empty keeps today's behaviour (no UI
 * listener); `workbench web` starts one regardless.
 */
export interface WebConfig {
  /** `serve`: also start the web UI listener (default false). */
  enabled?: boolean
  /** Bind host (default 127.0.0.1 - the UI has no auth in this round). */
  host?: string
  /** Bind port (default 12348; `0` picks a free port). */
  port?: number
}

/**
 * One row of the `plugins:` ROSTER (keyed by plugin name): a row's PRESENCE is
 * what makes the plugin load, its content is the plugin's config, and
 * `disabled: true` is the loader's own park flag (row present, not loaded).
 */
export interface PluginConfig {
  /** True when the loader must PARK this plugin (roster row present, not loaded). */
  disabled?: boolean
  [key: string]: unknown
}

/** The service the core provides to every plugin (`ctx.workbench`). */
export interface Workbench {
  /** Registers a command; returns the disposer that unregisters it again. */
  registerCommand(def: Omit<CommandDefinition, 'plugin'>): () => void
  commands(): CommandDefinition[]
  /** Resolves argv to the longest matching command, the rest becomes args. */
  resolve(argv: string[]): { command: CommandDefinition; args: string[] } | undefined
  plugins(): LoadedPlugin[]
  /**
   * The plugin whose `apply` is currently running (the loader's attribution
   * marker); `core` outside a plugin apply. A capability service uses it to
   * report the plugin that OWNS a registration (the tools inventory, the web
   * seam) rather than a caller supplied name.
   */
  attribution(): string
  log(message: string): void
  /** The loader inventory (read path; what `workbench plugins` prints). */
  inventory(): HostInventory
  /** The host (loader) mutation API: install/enable/disable/retry/compose. */
  host(): HostApi
  /** The config seam: view/edit/persist the active config file. */
  config(): ConfigApi
}

/** A cordis context with the workbench core service attached. */
export type WorkbenchContext = Context & { workbench: Workbench }

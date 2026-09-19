/**
 * The HOST (loader) API: the single write path to the live plugin set.
 *
 * Every mutation a UI (or any other consumer) performs goes through this class:
 * load, unload, reload, retry, enable, disable, install a source, uninstall a
 * source. It is deliberately NOT a second loader: discovering uses
 * {@link discoverPlugins} and instantiating uses {@link loadDiscovered}, the
 * very functions the boot uses, so a UI-driven load is the same operation as a
 * boot-time load (same import, same `ctx.plugin`, same command attribution and
 * the same clean disposal on unload).
 *
 * Persistence goes through the config seam ({@link updateConfigFile}): enable /
 * disable / install / uninstall are CONFIG edits (`plugins.<name>.disabled`,
 * `sources[]`), never hidden state. When the host runs on an inline config the
 * action still takes effect in the running process and reports
 * `persisted: false` with the reason from {@link Host.canPersist}.
 *
 * Every action returns the inventory BEFORE and AFTER, so a consumer can show
 * the real loader state change instead of claiming one.
 */
import path from 'node:path'
import type { Context, Fiber } from 'cordis'
import { readConfig } from './config.ts'
import { readRawConfig, updateConfigFile } from './configfile.ts'
import { discoverPlugins, isDisabled, isRosterMember, loadDiscovered, type LoadFailure, type PluginDiscovery, type SourceReport } from './loader.ts'
import { resolveSource, sourceId, type SourceAuthOutcome } from './sources.ts'
import type { ToolInfo } from './tool-registry.ts'
import {
  renderCapability,
  type CommandInfo,
  type ConfigPatch,
  type HostAction,
  type HostActionResult,
  type HostApi,
  type HostInventory,
  type LoadedPlugin,
  type PluginDiscoveryInfo,
  type PluginState,
  type SourceSpec,
  type WorkbenchConfig,
} from './types.ts'

/** One plugin the host knows about, with its live state. */
export interface HostEntry {
  discovery: PluginDiscovery
  state: PluginState
  fiber?: Fiber
  error?: string
  /** The config the plugin was instantiated with (references already expanded). */
  config?: Record<string, unknown>
}

export interface HostOptions {
  ctx: Context
  log: (message: string) => void
  /** Config file the host was booted from, or `(inline config)`. */
  configFile: string
  configDir: string
  cacheDir: string
  includeExternal: boolean
  /** Raw config as booted; re-read from {@link HostOptions.configFile} when it is a real file. */
  config: WorkbenchConfig
  /** Called for every discovery BEFORE import (credential provider declarations). */
  declare?: (discovery: PluginDiscovery) => void
  /**
   * The config a plugin is instantiated with: the raw `plugins.<name>` value
   * with credential references expanded by the kernel (credential VALUES never
   * pass through the host).
   */
  pluginConfig?: (name: string, raw: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>
  /**
   * Source AUTH resolved before the boot walk (the LIVE credentials service). A
   * `git` source that declares `auth` is fetched with it; the host re-resolves
   * it after a config change through {@link HostOptions.sourceAuthResolver}.
   */
  sourceAuth?: ReadonlyMap<string, SourceAuthOutcome>
  /**
   * Re-resolves source auth for a config: the LIVE credentials service (a provider
   * plugin, loaded from a source that needs no credential). Injected by the kernel
   * (composition root) so the host never names a provider.
   */
  sourceAuthResolver?: (config: WorkbenchConfig) => Promise<ReadonlyMap<string, SourceAuthOutcome>>
}

/** The slice of the core service the host needs (avoids an import cycle). */
interface RegistryLike {
  commands(): CommandInfo[] | { name: string; description?: string; plugin?: string }[]
  tools(): ToolInfo[]
  setPlugins(plugins: LoadedPlugin[]): void
}

/** Adopted boot state: what the kernel loaded before the host took over. */
export interface AdoptedState {
  config: WorkbenchConfig
  sources: SourceReport[]
  discoveries: PluginDiscovery[]
  plugins: LoadedPlugin[]
  failures: LoadFailure[]
  fibers: Map<string, Fiber>
  disabled: string[]
}

export class Host implements HostApi {
  readonly ctx: Context
  readonly options: HostOptions
  private entries = new Map<string, HostEntry>()
  private sourceReports: SourceReport[] = []
  private current: WorkbenchConfig
  private sourceAuth: ReadonlyMap<string, SourceAuthOutcome>

  constructor(options: HostOptions) {
    this.options = options
    this.ctx = options.ctx
    this.current = options.config
    this.sourceAuth = options.sourceAuth ?? new Map()
  }

  /**
   * Re-resolves source auth from the current config. Runs after a config edit
   * and BEFORE the refresh that walks the sources, so a newly installed private
   * source is fetched with its credential (and a removed one is forgotten).
   * Never throws: the resolver reports failures per source.
   */
  async refreshSourceAuths(): Promise<void> {
    this.sourceAuth = await this.resolveAuths(this.rawConfig())
  }

  private async resolveAuths(config: WorkbenchConfig): Promise<ReadonlyMap<string, SourceAuthOutcome>> {
    const resolver = this.options.sourceAuthResolver
    if (resolver === undefined) return this.sourceAuth
    try {
      return await resolver(config)
    } catch (error) {
      this.options.log(`host: source auth could not be resolved (${error instanceof Error ? error.message : String(error)})`)
      return this.sourceAuth
    }
  }

  private registry(): RegistryLike {
    return (this.ctx as unknown as { workbench: RegistryLike }).workbench
  }

  /**
   * The state of a discovered plugin that is NOT loaded: ROSTER-AWARE. A plugin
   * the config does not name under `plugins:` is `available` (discovered,
   * installable with one `enable`, never imported); a named row with
   * `disabled: true` is `disabled` (parked). The state of a plugin that loaded
   * or failed is set by the caller, never here.
   */
  private restState(name: string): PluginState {
    const config = this.rawConfig()
    if (!isRosterMember(config, name)) return 'available'
    return isDisabled(config, name) ? 'disabled' : 'available'
  }

  /** Takes over the state of a boot performed by the kernel. */
  adopt(state: AdoptedState): void {
    this.current = state.config
    this.sourceReports = state.sources
    for (const discovery of state.discoveries) {
      this.entries.set(discovery.name, { discovery, state: this.restState(discovery.name) })
    }
    for (const plugin of state.plugins) {
      const entry = this.entries.get(plugin.name)
      const fiber = state.fibers.get(plugin.name)
      this.entries.set(plugin.name, {
        discovery: entry?.discovery ?? discoveryOf(plugin),
        state: 'loaded',
        ...(fiber === undefined ? {} : { fiber }),
      })
    }
    for (const failure of state.failures) {
      const entry = this.entries.get(failure.plugin)
      if (entry === undefined) continue
      entry.state = 'failed'
      entry.error = failure.error
    }
    for (const name of state.disabled) {
      const entry = this.entries.get(name)
      if (entry !== undefined) entry.state = 'disabled'
    }
    this.syncRegistry()
  }

  // ---------------------------------------------------------------- read path

  /** The loader inventory: the data every read surface shows. */
  inventory(): HostInventory {
    const registry = this.registry()
    const commands = registry.commands() as CommandInfo[]
    const tools = registry.tools() as ToolInfo[]
    const config = this.writtenConfig()
    const entries = [...this.entries.values()].sort((a, b) => a.discovery.name.localeCompare(b.discovery.name))
    const plugins: LoadedPlugin[] = []
    const failures: LoadFailure[] = []
    const disabled: string[] = []
    const available: string[] = []
    const discovered: PluginDiscoveryInfo[] = []
    const loadedPerSource = new Map<string, number>()
    for (const entry of entries) {
      const { discovery } = entry
      if (entry.state === 'loaded') {
        plugins.push(loadedOf(discovery))
        loadedPerSource.set(discovery.source, (loadedPerSource.get(discovery.source) ?? 0) + 1)
      }
      if (entry.state === 'failed') {
        failures.push({ plugin: discovery.name, source: discovery.source, error: entry.error ?? 'unknown error' })
      }
      if (entry.state === 'disabled') disabled.push(discovery.name)
      if (entry.state === 'available') available.push(discovery.name)
      discovered.push({
        name: discovery.name,
        version: discovery.version,
        description: discovery.description,
        dir: discovery.dir,
        source: discovery.source,
        external: discovery.external,
        capabilities: discovery.capabilities.map(renderCapability),
        state: entry.state,
        roster: isRosterMember(config, discovery.name),
        ...(entry.error === undefined ? {} : { error: entry.error }),
        commands: commands.filter((command) => command.plugin === discovery.name).map((command) => command.name),
      })
    }
    const sources = this.sourceReports.map((source) => ({ ...source, plugins: loadedPerSource.get(source.id) ?? 0 }))
    return {
      configFile: this.options.configFile,
      plugins,
      sources,
      failures,
      disabled,
      available,
      discovered,
      commands: commands.map(({ name, description, plugin }) => ({ name, description, plugin })),
      tools,
    }
  }

  /** The config file the host edits, or undefined for an inline config. */
  configFilePath(): string | undefined {
    return this.options.configFile.startsWith('(') ? undefined : path.resolve(this.options.configFile)
  }

  canPersist(): { ok: boolean; reason?: string } {
    const file = this.configFilePath()
    if (file === undefined) return { ok: false, reason: 'the host was booted from an inline config (no file to persist to)' }
    return { ok: true }
  }

  /**
   * The config as a plugin is instantiated with it: `${env:VAR}` references are
   * expanded here. This is NOT the config as written - a read surface must use
   * {@link writtenConfig} instead.
   */
  rawConfig(): WorkbenchConfig {
    const file = this.configFilePath()
    if (file === undefined) return this.current
    return readConfig(file).config
  }

  /**
   * The config EXACTLY AS WRITTEN: the file parsed again, with no `${env:VAR}`
   * expansion, so every reference (`${env:VAR}` and `${cred:NAME}`) stays
   * visible BY NAME. Falls back to the booted config when the host runs on an
   * inline config (there is no file to read).
   */
  writtenConfig(): WorkbenchConfig {
    const file = this.configFilePath()
    if (file === undefined) return this.current
    const value = readRawConfig(file).value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return this.current
    return value as WorkbenchConfig
  }

  /**
   * Per-plugin config AS WRITTEN (every reference, `${env:VAR}` included, stays
   * BY NAME): the Settings surface must never receive a resolved value, so this
   * reads the file as written, not the config a plugin was instantiated with.
   */
  pluginConfigView(name: string): Record<string, unknown> {
    return { ...(this.writtenConfig().plugins?.[name] ?? {}) }
  }

  /** Re-reads the config file after an external write (the config seam). */
  reloadConfig(): WorkbenchConfig {
    this.current = this.rawConfig()
    return this.current
  }

  // ------------------------------------------------------------ action driver

  private async perform(
    action: HostAction,
    target: string,
    request: Record<string, unknown>,
    mutate: (state: { persisted: boolean }) => Promise<string> | string,
  ): Promise<HostActionResult> {
    const before = this.inventory()
    const state = { persisted: false }
    let message: string
    let ok = true
    try {
      message = await mutate(state)
      await this.refreshSourceAuths()
    } catch (error) {
      ok = false
      message = `${action} '${target}' failed: ${error instanceof Error ? error.message : String(error)}`
      this.options.log(`host: ${message}`)
    }
    this.refresh()
    return { ok, action, target, request, persisted: state.persisted, before, after: this.inventory(), message }
  }

  /** Re-scans the configured sources so new/removed plugins become visible. */
  private refresh(): void {
    const found = discoverPlugins({
      config: this.rawConfig(),
      configDir: this.options.configDir,
      cacheDir: this.options.cacheDir,
      includeExternal: this.options.includeExternal,
      sourceAuth: this.sourceAuth,
      log: this.options.log,
    })
    this.sourceReports = found.sources
    const seen = new Set<string>()
    for (const discovery of found.discoveries) {
      seen.add(discovery.name)
      const entry = this.entries.get(discovery.name)
      if (entry === undefined) this.entries.set(discovery.name, { discovery, state: this.restState(discovery.name) })
      else entry.discovery = discovery
    }
    for (const [name, entry] of [...this.entries]) {
      if (seen.has(name)) continue
      if (entry.state === 'loaded') continue
      this.entries.delete(name)
    }
    this.syncRegistry()
  }

  /** Keeps `ctx.workbench.plugins()` in step with the loaded set. */
  private syncRegistry(): void {
    const loaded = [...this.entries.values()].filter((entry) => entry.state === 'loaded').map((entry) => loadedOf(entry.discovery))
    this.registry().setPlugins(loaded)
  }

  /** Finds the discovery of a plugin, refreshing once when the host does not know it. */
  private discoveryOf(name: string): PluginDiscovery {
    const known = this.entries.get(name)?.discovery
    if (known !== undefined) return known
    this.refresh()
    const found = this.entries.get(name)?.discovery
    if (found === undefined) {
      throw new Error(`plugin '${name}' is not discovered in any configured source (check the source list and the config file)`)
    }
    return found
  }

  private async pluginConfigFor(name: string, raw: Record<string, unknown>): Promise<Record<string, unknown>> {
    const withoutFlag = { ...raw }
    delete withoutFlag.disabled
    return (await this.options.pluginConfig?.(name, withoutFlag)) ?? withoutFlag
  }

  // -------------------------------------------------------------- action impl

  /**
   * Declares a plugin's manifest capabilities right before it is loaded - the
   * same step the boot performs (see `kernel.ts`). A provider may only register
   * a provider its manifest DECLARED, so a UI-driven load (load / reload /
   * retry / enable) must declare it too, or `apply()` fails.
   */
  private declareCapabilities(discovery: PluginDiscovery): void {
    this.options.declare?.(discovery)
  }

  async load(name: string): Promise<HostActionResult> {
    return this.perform('load', name, { name }, async () => {
      const entry = this.entries.get(name)
      if (entry?.state === 'loaded') return `plugin '${name}' is already loaded`
      const discovery = this.discoveryOf(name)
      const raw = this.rawConfig().plugins?.[name] ?? {}
      if (raw.disabled === true) {
        this.options.log(`host: plugin '${name}' is disabled in the config, loading it anyway (explicit request)`)
      }
      const config = await this.pluginConfigFor(name, raw)
      this.declareCapabilities(discovery)
      const { fiber } = await loadDiscovered(this.ctx, discovery, config, this.options.log)
      this.entries.set(name, { discovery, state: 'loaded', fiber })
      this.syncRegistry()
      return `loaded plugin '${name}' from ${discovery.source}`
    })
  }

  async unload(name: string): Promise<HostActionResult> {
    return this.perform('unload', name, { name }, async () => {
      const entry = this.entries.get(name)
      if (entry === undefined || entry.state !== 'loaded') {
        throw new Error(`plugin '${name}' is not loaded (state: ${entry?.state ?? 'unknown'})`)
      }
      await entry.fiber?.dispose()
      entry.state = 'available'
      delete entry.fiber
      delete entry.config
      this.syncRegistry()
      return `unloaded plugin '${name}' (its commands, routes, assets and pages are disposed)`
    })
  }

  async reload(name: string): Promise<HostActionResult> {
    return this.perform('reload', name, { name }, async () => {
      const entry = this.entries.get(name)
      if (entry?.state === 'loaded') {
        await entry.fiber?.dispose()
        entry.state = 'available'
        delete entry.fiber
        delete entry.config
        this.syncRegistry()
      }
      const discovery = this.discoveryOf(name)
      const raw = this.rawConfig().plugins?.[name] ?? {}
      const config = await this.pluginConfigFor(name, raw)
      this.declareCapabilities(discovery)
      const { fiber } = await loadDiscovered(this.ctx, discovery, config, this.options.log)
      this.entries.set(name, { discovery, state: 'loaded', fiber })
      this.syncRegistry()
      return `reloaded plugin '${name}' from ${discovery.source}`
    })
  }

  async retry(name: string): Promise<HostActionResult> {
    return this.perform('retry', name, { name }, async () => {
      const entry = this.entries.get(name)
      if (entry !== undefined && entry.state === 'loaded') {
        await entry.fiber?.dispose()
        this.syncRegistry()
      }
      const discovery = this.discoveryOf(name)
      const raw = this.rawConfig().plugins?.[name] ?? {}
      const config = await this.pluginConfigFor(name, raw)
      this.declareCapabilities(discovery)
      const { fiber } = await loadDiscovered(this.ctx, discovery, config, this.options.log)
      this.entries.set(name, { discovery, state: 'loaded', fiber })
      this.syncRegistry()
      return `retried plugin '${name}' - it loaded from ${discovery.source}`
    })
  }

  /**
   * Enables a plugin: it PERSISTS the `plugins.<name>` ROSTER ROW (creating an
   * empty one when the plugin was only available, clearing `disabled: true`
   * when it was parked) and loads it. The row is what makes the plugin load
   * again on the next boot - `load` alone loads it for this process only.
   */
  async enable(name: string): Promise<HostActionResult> {
    return this.perform('enable', name, { name }, async (state) => {
      const discovery = this.discoveryOf(name)
      const file = this.configFilePath()
      const written = this.rawConfig()
      const onRoster = isRosterMember(written, name)
      const parked = isDisabled(written, name)
      const patch: ConfigPatch[] = []
      if (!onRoster) patch.push({ op: 'set', path: ['plugins', name], value: {} })
      if (parked) patch.push({ op: 'delete', path: ['plugins', name, 'disabled'] })
      if (patch.length > 0) {
        if (file === undefined) {
          throw new Error('the host has no config file to persist the roster row to (inline config)')
        }
        updateConfigFile(file, patch)
        state.persisted = true
        this.reloadConfig()
      }
      const entry = this.entries.get(name)
      if (entry?.state === 'loaded') {
        return `plugin '${name}' is already loaded (it is on the 'plugins:' roster${state.persisted ? ', row persisted' : ''})`
      }
      if (entry !== undefined) entry.state = 'available'
      const raw = this.rawConfig().plugins?.[name] ?? {}
      const config = await this.pluginConfigFor(name, raw)
      this.declareCapabilities(discovery)
      const { fiber } = await loadDiscovered(this.ctx, discovery, config, this.options.log)
      this.entries.set(name, { discovery, state: 'loaded', fiber })
      this.syncRegistry()
      const what = onRoster
        ? parked
          ? "its 'disabled' flag is cleared"
          : 'it was already on the roster'
        : `'plugins.${name}' added to the roster`
      return `enabled plugin '${name}' (${what}, config${state.persisted ? ' updated' : ' unchanged'}, plugin loaded)`
    })
  }

  /**
   * Disables a plugin: it is unloaded and PARKED with a persisted
   * `plugins.<name>.disabled: true`. The roster row stays (the plugin is
   * configured, deliberately off) and the inventory reports it under `disabled`,
   * never under `failures`. A plugin that is only AVAILABLE (no roster row) is
   * already not loaded: there is nothing to park, and no row is invented.
   */
  async disable(name: string): Promise<HostActionResult> {
    return this.perform('disable', name, { name }, async (state) => {
      const entry = this.entries.get(name)
      if (entry === undefined) throw new Error(`plugin '${name}' is not discovered in any configured source`)
      if (!isRosterMember(this.rawConfig(), name)) {
        if (entry.state === 'loaded') {
          await entry.fiber?.dispose()
          delete entry.fiber
          delete entry.config
          entry.state = 'available'
          this.syncRegistry()
          return `unloaded plugin '${name}' (not on the 'plugins:' roster, so there is no row to park - it stays available)`
        }
        return `plugin '${name}' is available (not on the 'plugins:' roster) and not loaded - nothing to park`
      }
      if (entry.state === 'loaded') {
        await entry.fiber?.dispose()
        delete entry.fiber
        delete entry.config
        this.syncRegistry()
      }
      const file = this.configFilePath()
      if (file === undefined) {
        entry.state = 'disabled'
        throw new Error('plugin unloaded, but the host has no config file to persist the disable to')
      }
      const patch: ConfigPatch[] = [{ op: 'set', path: ['plugins', name, 'disabled'], value: true }]
      updateConfigFile(file, patch)
      state.persisted = true
      this.reloadConfig()
      entry.state = 'disabled'
      return `disabled plugin '${name}' (unloaded and 'plugins.${name}.disabled: true' persisted)`
    })
  }

  async install(spec: SourceSpec): Promise<HostActionResult> {
    const target = spec.id ?? spec.path ?? spec.url ?? '(source)'
    return this.perform('install-source', target, { source: spec }, async (state) => {
      const raw = this.rawConfig()
      if (raw.sources.some((source) => (spec.id !== undefined && source.id === spec.id) || (source.kind === spec.kind && source.path !== undefined && source.path === spec.path) || (source.kind === 'git' && spec.url !== undefined && source.url === spec.url))) {
        throw new Error(`a source with id '${target}' is already configured`)
      }
      // Resolving the source before persisting it validates the coordinate (a
      // git source is checked out into the cache here, by the loader, not by us).
      // The new source goes into a CANDIDATE config first so its own `auth` (a
      // private git source) is resolved through the credentials service before the fetch.
      const candidate: WorkbenchConfig = { ...raw, sources: [...raw.sources, spec] }
      const auth = (await this.resolveAuths(candidate)).get(sourceId(spec, this.options.configDir))
      const resolved = resolveSource(spec, this.options.configDir, this.options.cacheDir, auth)
      if (resolved.error || !resolved.dir) throw new Error(`source '${target}' did not resolve: ${resolved.error ?? 'no directory'}`)
      const file = this.configFilePath()
      if (file === undefined) throw new Error('the host has no config file to persist the new source to')
      updateConfigFile(file, [{ op: 'append', path: ['sources'], value: spec as unknown as Record<string, unknown> }])
      state.persisted = true
      this.reloadConfig()
      this.refresh()
      const added = [...this.entries.values()].filter((entry) => entry.discovery.source === resolved.id)
      let loaded = 0
      let available = 0
      for (const entry of added) {
        if (entry.state === 'loaded') continue
        // ROSTER semantics: a newly discovered source makes its plugins
        // AVAILABLE, it does not load them. Only a plugin the config names in
        // `plugins:` is loaded (the same predicate as the boot path).
        if (!isRosterMember(this.rawConfig(), entry.discovery.name)) {
          entry.state = 'available'
          available += 1
          continue
        }
        try {
          const config = await this.pluginConfigFor(entry.discovery.name, this.rawConfig().plugins?.[entry.discovery.name] ?? {})
          this.declareCapabilities(entry.discovery)
          const { fiber } = await loadDiscovered(this.ctx, entry.discovery, config, this.options.log)
          entry.state = 'loaded'
          entry.fiber = fiber
          loaded += 1
        } catch (error) {
          entry.state = 'failed'
          entry.error = error instanceof Error ? error.message : String(error)
          this.options.log(`host: plugin ${entry.discovery.name} from the new source failed: ${entry.error}`)
        }
      }
      this.syncRegistry()
      return `installed source '${resolved.id}' (${resolved.kind}${resolved.dir ? ` ${resolved.dir}` : ''}), ${loaded} of ${added.length} plugin(s) loaded, ${available} available to enable`
    })
  }

  async uninstall(id: string): Promise<HostActionResult> {
    return this.perform('remove-source', id, { id }, async (state) => {
      const raw = this.rawConfig()
      const index = raw.sources.findIndex((source) => source.id === id)
      if (index < 0) throw new Error(`no configured source with id '${id}'`)
      const unloaded: string[] = []
      for (const entry of [...this.entries.values()]) {
        if (entry.discovery.source !== id) continue
        if (entry.state === 'loaded') {
          await entry.fiber?.dispose()
          unloaded.push(entry.discovery.name)
        }
        // Forget the entry too: `refresh()` below only prunes entries that are
        // not loaded, so a disposed plugin must leave the loaded state or it
        // would stay in the inventory forever (and keep being served).
        entry.state = 'available'
        delete entry.fiber
        delete entry.config
      }
      const file = this.configFilePath()
      if (file === undefined) throw new Error('the host has no config file to persist the source removal to')
      updateConfigFile(file, [{ op: 'delete', path: ['sources', index] }])
      state.persisted = true
      this.reloadConfig()
      this.refresh()
      this.syncRegistry()
      return `removed source '${id}' (unloaded ${unloaded.length} plugin(s): ${unloaded.join(', ') || 'none'})`
    })
  }
}

/** The {@link LoadedPlugin} shape of a discovery. */
function loadedOf(discovery: PluginDiscovery): LoadedPlugin {
  return {
    name: discovery.name,
    version: discovery.version,
    description: discovery.description,
    capabilities: discovery.capabilities.map(renderCapability),
    capabilityList: discovery.capabilities,
    source: discovery.source,
    dir: discovery.dir,
    external: discovery.external,
  }
}

/** The (partial) discovery a plugin record can rebuild when the scan did not see it. */
function discoveryOf(plugin: LoadedPlugin): PluginDiscovery {
  return {
    name: plugin.name,
    version: plugin.version,
    description: plugin.description,
    dir: plugin.dir,
    source: plugin.source,
    external: plugin.external,
    capabilities: plugin.capabilityList ?? [],
  }
}

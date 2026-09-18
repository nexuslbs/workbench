import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Fiber } from 'cordis'
import { markApplying } from './attribution.ts'
import { resolveSource, type ResolvedSource } from './sources.ts'
import {
  MANIFEST_FILE,
  normalizeCapabilities,
  renderCapability,
  type CapabilityDeclaration,
  type PluginManifest,
  type LoadedPlugin,
  type WorkbenchConfig,
} from './types.ts'

export interface LoadFailure {
  plugin: string
  source: string
  error: string
}

export interface SourceReport {
  id: string
  kind: string
  dir: string | null
  external: boolean
  plugins: number
  error?: string
}

export interface LoadReport {
  plugins: LoadedPlugin[]
  failures: LoadFailure[]
  sources: SourceReport[]
  /** Every plugin discovered in the configured sources, loaded or not. */
  discoveries: PluginDiscovery[]
  /** Names of discovered plugins the config disables (`plugins.<name>.disabled`). */
  disabled: string[]
  /**
   * The cordis fiber of every LOADED plugin, keyed by plugin name. Kept out of
   * {@link LoadedPlugin} on purpose: a fiber is a live object and must never end
   * up in JSON output.
   */
  fibers: Map<string, Fiber>
}

export interface LoadOptions {
  config: WorkbenchConfig
  /** Directory the relative source paths resolve against (the config file directory). */
  configDir: string
  /** Directory for cached git sources. */
  cacheDir: string
  /** Set false to skip external sources (`--no-external`). */
  includeExternal: boolean
  log: (message: string) => void
  /**
   * Called for every discovered plugin BEFORE its entry module is imported, so
   * the core can act on the manifest declarations (the credentials provider ids
   * a plugin claims) before the plugin registers its services.
   */
  declare?: (discovery: PluginDiscovery) => void
  /** Loads only the discovered plugins this predicate accepts (two-phase loading). */
  filter?: (discovery: PluginDiscovery) => boolean
}

/** A discovered plugin: its manifest and where it came from, before import. */
export interface PluginDiscovery {
  name: string
  version: string
  description?: string
  /** Absolute plugin directory. */
  dir: string
  /** Source id the plugin was discovered in (e.g. `core`, `workbench-plugins`). */
  source: string
  /** True when the plugin came from a non-core (external) source. */
  external: boolean
  /** Manifest capabilities, structured. */
  capabilities: CapabilityDeclaration[]
}

/** What one source walk found: the report plus the plugins discovered in it. */
export interface DiscoverReport {
  sources: SourceReport[]
  discoveries: PluginDiscovery[]
  failures: LoadFailure[]
}

/** Reads and minimally validates a plugin manifest. */
export function readManifest(dir: string): PluginManifest {
  const file = path.join(dir, MANIFEST_FILE)
  if (!fs.existsSync(file)) throw new Error(`manifest ${MANIFEST_FILE} not found in ${dir}`)
  const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PluginManifest
  for (const field of ['name', 'version', 'entry'] as const) {
    if (typeof manifest[field] !== 'string' || manifest[field].length === 0) {
      throw new Error(`manifest ${file}: '${field}' must be a non-empty string`)
    }
  }
  if (manifest.capabilities !== undefined && !Array.isArray(manifest.capabilities)) {
    throw new Error(`manifest ${file}: 'capabilities' must be an array`)
  }
  // Validates both capability forms (the short string form and the structured
  // declaration form credential providers use); the manifest stays additive.
  normalizeCapabilities(manifest.capabilities, `manifest ${file}`)
  return manifest
}

/** Plugin directories of a source: immediate subdirectories containing a manifest. */
export function discoverPluginDirs(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, MANIFEST_FILE)))
    .map((entry) => path.join(dir, entry.name))
    .sort()
}

/** Cordis plugin object or bare apply function, as exported by a plugin entry module. */
type PluginLike = { name?: string; inject?: string[]; apply: (ctx: Context, config: unknown) => unknown }

function normalizeExport(exported: unknown, manifest: PluginManifest, file: string): PluginLike {
  const candidate = (exported as { default?: unknown })?.default ?? exported
  const plugin = (typeof candidate === 'function' ? { apply: candidate } : candidate) as PluginLike | null
  if (!plugin || typeof plugin.apply !== 'function') {
    throw new Error(`${file}: the entry module must export a cordis plugin (default export with an 'apply' function)`)
  }
  // The manifest is authoritative for the plugin name.
  return { ...plugin, name: manifest.name }
}

/** True when the config disables a plugin (`plugins.<name>.disabled: true`). */
export function isDisabled(config: WorkbenchConfig, name: string): boolean {
  return config.plugins?.[name]?.disabled === true
}

/**
 * Walks every configured source and reports the plugins it holds, WITHOUT
 * importing anything. This is the discovery half of {@link loadPlugins} and the
 * read path the host API reuses to refresh its view after a config change.
 */
export function discoverPlugins(options: LoadOptions): DiscoverReport {
  const report: DiscoverReport = { sources: [], discoveries: [], failures: [] }

  for (const spec of options.config.sources) {
    const external = spec.external !== false
    if (external && !options.includeExternal) continue

    const source: ResolvedSource = resolveSource(spec, options.configDir, options.cacheDir)
    const sourceReport: SourceReport = { id: source.id, kind: source.kind, dir: source.dir, external, plugins: 0 }
    if (source.error || !source.dir) {
      sourceReport.error = source.error ?? 'source has no directory'
      options.log(`source '${source.id}' skipped: ${sourceReport.error}`)
      report.sources.push(sourceReport)
      continue
    }

    for (const dir of discoverPluginDirs(source.dir)) {
      let manifest: PluginManifest
      let discovery: PluginDiscovery
      try {
        manifest = readManifest(dir)
        discovery = {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          dir,
          source: source.id,
          external,
          capabilities: normalizeCapabilities(manifest.capabilities, `manifest ${path.join(dir, MANIFEST_FILE)}`),
        }
      } catch (error) {
        report.failures.push({ plugin: path.basename(dir), source: source.id, error: (error as Error).message })
        continue
      }
      report.discoveries.push(discovery)
      sourceReport.plugins += 1
    }
    report.sources.push(sourceReport)
  }

  return report
}

/**
 * Imports and loads ONE discovered plugin into the context, attributing its
 * registrations to it, and returns the {@link LoadedPlugin} plus its fiber.
 *
 * This is the write half of the loader, and the single place a plugin is
 * instantiated: the boot ({@link loadPlugins}) and every host action (load /
 * enable / retry / reload) go through it, so a UI-driven mutation is the same
 * operation as a boot-time load.
 */
export async function loadDiscovered(
  ctx: Context,
  discovery: PluginDiscovery,
  pluginConfig: Record<string, unknown>,
  log: (message: string) => void,
): Promise<{ plugin: LoadedPlugin; fiber: Fiber }> {
  const workbench = (
    ctx as unknown as { workbench: { attribute(plugin: string, known: Set<string>): void; commandNames(): Set<string> } }
  ).workbench
  const file = path.resolve(discovery.dir, readManifest(discovery.dir).entry)
  if (!fs.existsSync(file)) throw new Error(`entry module not found: ${file}`)
  const known = workbench.commandNames()
  const mod = (await import(pathToFileURL(file).href)) as unknown
  const plugin = normalizeExport(mod, { ...(readManifest(discovery.dir) as PluginManifest) }, file)
  // Plugin objects are user supplied: cordis' generic plugin signature cannot be
  // expressed for a dynamically imported module, so the context call is cast.
  const plug = ctx as unknown as { plugin(plugin: unknown, config?: unknown): Fiber & PromiseLike<Fiber> }
  const restore = markApplying(discovery.name)
  let fiber: Fiber
  try {
    fiber = await plug.plugin(plugin, pluginConfig)
  } finally {
    restore()
  }
  workbench.attribute(discovery.name, known)
  const loaded: LoadedPlugin = {
    name: discovery.name,
    version: discovery.version,
    description: discovery.description,
    capabilities: discovery.capabilities.map(renderCapability),
    capabilityList: discovery.capabilities,
    source: discovery.source,
    dir: discovery.dir,
    external: discovery.external,
  }
  log(`loaded plugin ${discovery.name}@${discovery.version} from ${discovery.source} (${discovery.external ? 'external' : 'core'})`)
  return { plugin: loaded, fiber }
}

/**
 * Discovers, imports and loads every plugin of every configured source into the
 * given cordis context. A failing plugin is reported, never fatal. A plugin the
 * config disables (`plugins.<name>.disabled: true`) is reported as disabled and
 * is NOT imported.
 */
export async function loadPlugins(ctx: Context, options: LoadOptions): Promise<LoadReport> {
  const found = discoverPlugins(options)
  const report: LoadReport = {
    plugins: [],
    failures: [...found.failures],
    sources: found.sources,
    discoveries: found.discoveries,
    disabled: [],
    fibers: new Map<string, Fiber>(),
  }
  const counts = new Map<string, number>()

  for (const discovery of found.discoveries) {
    if (options.filter && !options.filter(discovery)) continue
    options.declare?.(discovery)
    const pluginConfig = { ...(options.config.plugins?.[discovery.name] ?? {}) }
    if (pluginConfig.disabled === true) {
      report.disabled.push(discovery.name)
      options.log(`plugin ${discovery.name} is disabled in the config, not loaded`)
      continue
    }
    delete pluginConfig.disabled
    try {
      const { plugin, fiber } = await loadDiscovered(ctx, discovery, pluginConfig, options.log)
      report.plugins.push(plugin)
      report.fibers.set(discovery.name, fiber)
      counts.set(discovery.source, (counts.get(discovery.source) ?? 0) + 1)
    } catch (error) {
      let message = (error as Error).message ?? String(error)
      if (message.includes('without inject')) {
        message += ` - a plugin that uses the core service must declare inject: ['workbench'] in its entry module`
      }
      report.failures.push({ plugin: discovery.name, source: discovery.source, error: message })
      options.log(`plugin ${discovery.name} from ${discovery.source} failed: ${message}`)
    }
  }

  report.sources = report.sources.map((source) => ({ ...source, plugins: counts.get(source.id) ?? 0 }))
  return report
}

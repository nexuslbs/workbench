import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from 'cordis'
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

/**
 * Discovers, imports and loads every plugin of every configured source into the
 * given cordis context. A failing plugin is reported, never fatal.
 */
export async function loadPlugins(ctx: Context, options: LoadOptions): Promise<LoadReport> {
  const report: LoadReport = { plugins: [], failures: [], sources: [] }
  const workbench = (ctx as unknown as { workbench: { attribute(plugin: string, known: Set<string>): void; commandNames(): Set<string> } }).workbench

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
      if (options.filter && !options.filter(discovery)) continue
      options.declare?.(discovery)
      try {
        const file = path.resolve(dir, manifest.entry)
        if (!fs.existsSync(file)) throw new Error(`entry module not found: ${file}`)
        const known = workbench.commandNames()
        const mod = (await import(pathToFileURL(file).href)) as unknown
        const plugin = normalizeExport(mod, manifest, file)
        // Plugin objects are user supplied: cordis' generic plugin signature cannot
        // be expressed for a dynamically imported module, so the context call is cast.
        const plug = ctx as unknown as { plugin(plugin: unknown, config?: unknown): unknown }
        await plug.plugin(plugin, options.config.plugins?.[manifest.name] ?? {})
        workbench.attribute(manifest.name, known)
        const loaded: LoadedPlugin = {
          name: manifest.name,
          version: manifest.version,
          description: manifest.description,
          capabilities: discovery.capabilities.map(renderCapability),
          capabilityList: discovery.capabilities,
          source: source.id,
          dir,
          external,
        }
        report.plugins.push(loaded)
        sourceReport.plugins += 1
        options.log(`loaded plugin ${manifest.name}@${manifest.version} from ${source.id} (${external ? 'external' : 'core'})`)
      } catch (error) {
        let message = (error as Error).message ?? String(error)
        if (message.includes('without inject')) {
          message += ` - a plugin that uses the core service must declare inject: ['workbench'] in its entry module`
        }
        report.failures.push({ plugin: manifest.name, source: source.id, error: message })
        options.log(`plugin ${manifest.name} from ${source.id} failed: ${message}`)
      }
    }
    report.sources.push(sourceReport)
  }

  return report
}

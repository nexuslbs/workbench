import type { Context } from 'cordis'

/** Manifest file name, one per plugin directory. */
export const MANIFEST_FILE = 'workbench.plugin.json'

/** Shape of a plugin manifest (`workbench.plugin.json`). */
export interface PluginManifest {
  /** Unique plugin name. */
  name: string
  version: string
  description?: string
  /** Entry module, relative to the plugin directory (ESM). */
  entry: string
  /** Capabilities the plugin provides, e.g. `command:hello world`. */
  capabilities?: string[]
  /** JSON-schema-ish description of the plugin config. */
  config?: Record<string, unknown>
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
  capabilities: string[]
  /** Source id the plugin was discovered in (e.g. `core`, `workbench-plugins`). */
  source: string
  /** Absolute plugin directory. */
  dir: string
  /** True when the plugin came from a non-core (external) source. */
  external: boolean
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
}

/** The workbench config file (`workbench.config.json`). */
export interface WorkbenchConfig {
  sources: SourceSpec[]
  /** Per plugin config, keyed by plugin name. */
  plugins?: Record<string, Record<string, unknown>>
}

/** The service the core provides to every plugin (`ctx.workbench`). */
export interface Workbench {
  /** Registers a command; returns the disposer that unregisters it again. */
  registerCommand(def: Omit<CommandDefinition, 'plugin'>): () => void
  commands(): CommandDefinition[]
  /** Resolves argv to the longest matching command, the rest becomes args. */
  resolve(argv: string[]): { command: CommandDefinition; args: string[] } | undefined
  plugins(): LoadedPlugin[]
  log(message: string): void
}

/** A cordis context with the workbench core service attached. */
export type WorkbenchContext = Context & { workbench: Workbench }

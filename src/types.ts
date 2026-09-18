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

/** The workbench config file (`workbench.config.json`). */
export interface WorkbenchConfig {
  sources: SourceSpec[]
  /** Per plugin config, keyed by plugin name. */
  plugins?: Record<string, Record<string, unknown>>
  /** Credentials provider selection/precedence (see {@link CredentialsConfig}). */
  credentials?: CredentialsConfig
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

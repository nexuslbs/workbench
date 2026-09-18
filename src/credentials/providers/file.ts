/**
 * CORE credentials provider `file`: a credentials file whose LOCATION is
 * configuration. The config carries the path/format, never the values.
 *
 * Semantics (documented in `docs/CREDENTIALS.md`): the file is a JSON or YAML
 * mapping whose keys are either credential names with string values or scopes
 * (nested mappings of credential names). A reference with a scope resolves in
 * `doc[scope][name]`, a reference without one in `doc[name]`. A MISSING file
 * answers "not found" (undefined); an unreadable/invalid file, a non-string
 * value or an unknown extension is an error naming the key/path - never a value.
 */
import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { Context } from 'cordis'
import { CREDENTIALS_VERSION, refLabel, type CredentialProvider, type CredentialRef, type CredentialsService } from '../definition.ts'
import { candidateKeys } from './dotenv.ts'

/** Plugin name (also the per-plugin config key in the workbench config). */
export const name = 'credentials-file'
/** Provider id this module registers. */
export const providerId = 'file'

/** Default file name, resolved against the config file directory. */
export const DEFAULT_FILE = 'credentials.json'

export interface Config {
  /** Absolute path of the credentials file (resolved against the config dir). */
  path: string
  /** Explicit format; default: by extension (`.json` = JSON, `.yml`/`.yaml` = YAML). */
  format?: 'json' | 'yaml'
}

/** Normalises the plugin config: the path becomes absolute, the format validated. */
export function resolveConfig(raw: Record<string, unknown> = {}, configDir: string): Config {
  const rawPath = raw.path === undefined ? DEFAULT_FILE : raw.path
  if (typeof rawPath !== 'string' || rawPath.length === 0) {
    throw new Error(`credentials-file: 'path' must be a non-empty string (got ${JSON.stringify(rawPath)})`)
  }
  const format = raw.format
  if (format !== undefined && format !== 'json' && format !== 'yaml') {
    throw new Error(`credentials-file: 'format' must be 'json' or 'yaml' (got ${JSON.stringify(format)})`)
  }
  const file = path.resolve(configDir, rawPath)
  return format === undefined ? { path: file } : { path: file, format }
}

function formatOf(config: Config): 'json' | 'yaml' {
  if (config.format) return config.format
  const ext = path.extname(config.path).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  throw new Error(`credentials-file: cannot tell the format of ${config.path}; use .json/.yml/.yaml or set 'format'`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Reads and parses the file; undefined when it does not exist. */
function readDocument(config: Config): Record<string, unknown> | undefined {
  let text: string
  try {
    text = fs.readFileSync(config.path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`credentials-file: cannot read ${config.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const format = formatOf(config)
  let parsed: unknown
  try {
    parsed = format === 'json' ? JSON.parse(text) : parseYaml(text)
  } catch (error) {
    throw new Error(`credentials-file: invalid ${format.toUpperCase()} in ${config.path}: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (parsed === null || parsed === undefined) return {}
  if (!isRecord(parsed)) throw new Error(`credentials-file: ${config.path} must contain a mapping of credential names`)
  return parsed
}

function names(table: Record<string, unknown>): string[] {
  return Object.entries(table)
    .filter(([, value]) => typeof value === 'string')
    .map(([key]) => key)
}

export function createProvider(config: Config): CredentialProvider {
  return {
    id: providerId,
    version: CREDENTIALS_VERSION,
    describe: () => `credentials file ${config.path}`,
    list: () => {
      const document = readDocument(config)
      if (document === undefined) return []
      const top = Object.entries(document).filter(([, value]) => typeof value === 'string').map(([key]) => key)
      const scoped = Object.entries(document)
        .filter(([, value]) => isRecord(value))
        .flatMap(([scope, value]) => names(value as Record<string, unknown>).map((key) => `${scope}/${key}`))
      return [...top, ...scoped]
    },
    resolve: (ref: CredentialRef) => {
      const document = readDocument(config)
      if (document === undefined) return undefined
      const label = refLabel(ref)
      if (ref.scope) {
        const namespace = document[ref.scope]
        if (namespace === undefined) return undefined
        if (!isRecord(namespace)) {
          throw new Error(`credentials-file: '${ref.scope}' in ${config.path} must be a mapping of credential names`)
        }
        return stringLookup(namespace, ref.name, label, config)
      }
      return stringLookup(document, ref.name, label, config)
    },
  }
}

/**
 * Looks a name up by its candidate forms (exact, ENV form, kebab form), so a
 * file keyed `deploy-token` answers `DEPLOY_TOKEN` too.
 */
function stringLookup(table: Record<string, unknown>, name: string, label: string, config: Config): string | undefined {
  for (const key of candidateKeys(name)) {
    if (!(key in table)) continue
    const resolved = stringValue(table[key], label, config)
    if (resolved !== undefined) return resolved
  }
  return undefined
}

/** A configured key holding anything but a string is a config error (never a value). */
function stringValue(value: unknown, label: string, config: Config): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') {
    throw new Error(`credentials-file: '${label}' in ${config.path} must be a string (got ${Array.isArray(value) ? 'array' : typeof value})`)
  }
  return value === '' ? undefined : value
}

export function apply(ctx: Context & { credentials: CredentialsService }, config: Config): void {
  const provider = createProvider(config)
  ctx.effect(() => ctx.credentials.register(provider))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin

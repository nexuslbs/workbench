import fs from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'
import { parseCredentialRef, refLabel, type CredentialRef, type CredentialResolution } from './credentials/definition.ts'
import type { WorkbenchConfig } from './types.ts'

/**
 * Config file names looked up in the working directory, in order: the first one
 * that exists wins. `.yml` is preferred over `.yaml`, which is preferred over
 * `.json`, so a repo that ships only `workbench.config.json` keeps working
 * exactly as before.
 */
export const DEFAULT_CONFIG_FILES = ['workbench.config.yml', 'workbench.config.yaml', 'workbench.config.json'] as const

/** Primary default config file name (first candidate; see {@link DEFAULT_CONFIG_FILES}). */
export const DEFAULT_CONFIG_FILE = DEFAULT_CONFIG_FILES[0]

/** Config syntaxes the loader understands; the file extension selects one. */
export type ConfigFormat = 'json' | 'yaml'

/** Maps a config file extension to its format; unknown extensions are an error. */
export function configFormat(file: string): ConfigFormat {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.json') return 'json'
  if (ext === '.yml' || ext === '.yaml') return 'yaml'
  throw new Error(`config ${path.resolve(file)}: unsupported config extension '${ext || '(none)'}' (expected .json, .yml or .yaml)`)
}

function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile()
  } catch {
    return false
  }
}

/** Resolves the default config file in `dir` (first existing candidate), or undefined. */
export function resolveDefaultConfigFile(dir: string): string | undefined {
  for (const name of DEFAULT_CONFIG_FILES) {
    const candidate = path.resolve(dir, name)
    if (isFile(candidate)) return candidate
  }
  return undefined
}

/**
 * Resolves the default config file by searching `dirs` in order (each in the
 * {@link DEFAULT_CONFIG_FILES} order). Throws naming every candidate when none
 * exists - it never falls back to a different format silently.
 */
export function findDefaultConfigFile(dirs: string[]): string {
  for (const dir of dirs) {
    const found = resolveDefaultConfigFile(dir)
    if (found) return found
  }
  const searched = dirs
    .map((dir) => `  ${path.resolve(dir)}: ${DEFAULT_CONFIG_FILES.join(', ')}`)
    .join('\n')
  throw new Error(`config: no workbench config file found; looked for ${DEFAULT_CONFIG_FILES.join(', ')} in:\n${searched}`)
}

/** Config values may reference the environment: `${env:VAR}`. */
const ENV_REF = /\$\{env:([A-Z0-9_]+)\}/g

function expandEnv(value: string): string {
  return value.replace(ENV_REF, (_match, name: string) => {
    const resolved = process.env[name]
    if (resolved === undefined) throw new Error(`env var ${name} referenced by the workbench config is not set`)
    return resolved
  })
}

/** Recursively expands `${env:VAR}` references in config values. */
export function expandEnvDeep(value: unknown): unknown {
  if (typeof value === 'string') return expandEnv(value)
  if (Array.isArray(value)) return value.map(expandEnvDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, expandEnvDeep(item)]))
  }
  return value
}

export interface ReadConfigResult {
  config: WorkbenchConfig
  /** Directory of the config file; relative source paths resolve against it. */
  dir: string
  file: string
}

/** Human readable type of a config value, for validation messages. */
function describeType(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** Renders a config value for a message: strings quoted, scalars as-is. */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  return describeType(value)
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/**
 * The parser (line, column) a YAML error reports, when it provides one. The
 * `yaml` package attaches `linePos: [{ line, col }]` to parse errors.
 */
function errorPosition(error: unknown): { line: number; col: number } | undefined {
  const linePos = (error as { linePos?: unknown } | null)?.linePos
  const first = Array.isArray(linePos) ? (linePos[0] as { line?: unknown; col?: unknown } | undefined) : undefined
  if (first && typeof first.line === 'number' && typeof first.col === 'number') return { line: first.line, col: first.col }
  return undefined
}

/** Wraps a parse failure in the `config <file>: ...` shape, keeping file/position. */
function parseError(file: string, format: ConfigFormat, error: unknown): Error {
  const detail = error instanceof Error ? error.message : String(error)
  const position = errorPosition(error)
  const location = position && !/\bline \d+/.test(detail) ? ` (line ${position.line}, column ${position.col})` : ''
  return new Error(`config ${file}: invalid ${format.toUpperCase()}${location}: ${detail}`)
}

/**
 * Reads and validates a workbench config file. `.yml`/`.yaml` files are parsed
 * as YAML, `.json` files as JSON; the rest of the pipeline (env expansion,
 * validation) is identical for both. Parse and validation failures always name
 * the config file; a broken file is never silently replaced by another format.
 */
export function readConfig(configFile: string): ReadConfigResult {
  const file = path.resolve(configFile)
  const format = configFormat(file)

  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`config ${file}: cannot read config file: ${error instanceof Error ? error.message : String(error)}`)
  }

  let raw: unknown
  if (format === 'json') {
    try {
      raw = JSON.parse(text)
    } catch (error) {
      throw parseError(file, format, error)
    }
  } else {
    try {
      raw = parseYaml(text)
    } catch (error) {
      throw parseError(file, format, error)
    }
  }

  const expanded = expandEnvDeep(raw)
  if (expanded === null || typeof expanded !== 'object' || Array.isArray(expanded)) {
    throw new Error(`config ${file}: the config root must be a mapping with a 'sources' array (got ${describeType(expanded)})`)
  }

  const root = expanded as Record<string, unknown>
  if (!Array.isArray(root.sources)) {
    throw new Error(`config ${file}: 'sources' must be an array (got ${describeType(root.sources)})`)
  }
  for (const source of root.sources as unknown[]) {
    if (source === null || typeof source !== 'object' || Array.isArray(source)) {
      throw new Error(`config ${file}: every source must be a mapping (got ${describeType(source)})`)
    }
    const spec = source as Record<string, unknown>
    if (spec.kind !== 'path' && spec.kind !== 'git') {
      throw new Error(`config ${file}: source kind must be 'path' or 'git' (got ${describe(spec.kind)})`)
    }
    if (spec.kind === 'path' && !isNonEmptyString(spec.path)) {
      throw new Error(`config ${file}: a 'path' source needs a 'path' string (got ${describe(spec.path)})`)
    }
    if (spec.kind === 'git' && !isNonEmptyString(spec.url)) {
      throw new Error(`config ${file}: a 'git' source needs a 'url' string (got ${describe(spec.url)})`)
    }
  }

  return { config: exportedConfig(expanded), dir: path.dirname(file), file }
}

function exportedConfig(expanded: object): WorkbenchConfig {
  const root = expanded as Record<string, unknown>
  return {
    ...(root as unknown as WorkbenchConfig),
    sources: root.sources as WorkbenchConfig['sources'],
  }
}

/**
 * Config values may reference a CREDENTIAL: `${cred:NAME}` or `${secret:NAME}`
 * (also `${cred:SCOPE/NAME}`). The reference is resolved through the credentials
 * SERVICE - this loader is a CONSUMER: it knows the definition and never a
 * provider. `${env:VAR}` keeps working exactly as before (it is expanded earlier
 * and matches a different pattern), so both kinds of reference can appear in one
 * file.
 */
const CRED_REF_SOURCE = '\\$\\{(cred|secret):([^}]*)\\}'

/** The part of the credentials service the config consumer needs (provider agnostic). */
export interface CredentialResolver {
  resolve(ref: CredentialRef): Promise<CredentialResolution | undefined>
  /** Enabled provider ids, in precedence order (for error messages). */
  enabled(): string[]
}

export interface CredentialExpansionOptions {
  /** Default scope for references that do not carry one (`credentials.scope`). */
  scope?: string
}

/** The `${` + kind + `:}` prefix, used in messages without confusing nesting. */
function refPrefix(kind: string): string {
  return '${' + kind + ':}'
}

/**
 * Expands the credential references of ONE string. An unresolvable reference is
 * an error naming the REFERENCE and the providers tried - never a value; and a
 * resolved value never appears in any message this loader produces.
 */
export async function expandCredentialRefs(
  value: string,
  resolver: CredentialResolver,
  options: CredentialExpansionOptions = {},
): Promise<string> {
  const pattern = new RegExp(CRED_REF_SOURCE, 'g')
  let result = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(value)) !== null) {
    const kind = match[1] ?? 'cred'
    const body = (match[2] ?? '').trim()
    if (body.length === 0) throw new Error(`config: an empty '${refPrefix(kind)}' credential reference is not allowed`)
    const parsed = parseCredentialRef(body)
    let resolution = await resolver.resolve(parsed)
    // The configured default scope (`credentials.scope`) is a FALLBACK: an
    // unscoped reference is first looked up unscoped and only then in the
    // default scope, so `${cred:NAME}` keeps working for a top-level credential.
    const fallback: CredentialRef | undefined =
      resolution === undefined && parsed.scope === undefined && options.scope
        ? { name: parsed.name, scope: options.scope }
        : undefined
    if (fallback) resolution = await resolver.resolve(fallback)
    if (!resolution) {
      const providers = resolver.enabled()
      const tried = fallback ? ` (the default scope '${fallback.scope}' was tried as well)` : ''
      throw new Error(
        `config: credential '${refLabel(parsed)}' could not be resolved by the enabled provider(s) ` +
          `${providers.length ? providers.join(', ') : '(none)'}${tried}; check the credential name and the 'credentials' section of the config`,
      )
    }
    result += value.slice(last, match.index) + resolution.value
    last = match.index + match[0].length
  }
  return result + value.slice(last)
}

/**
 * Recursively expands `${cred:NAME}` / `${secret:NAME}` references through the
 * credentials service. Returns a NEW value; the input is never mutated.
 */
export async function expandCredentialRefsDeep(
  value: unknown,
  resolver: CredentialResolver,
  options: CredentialExpansionOptions = {},
): Promise<unknown> {
  if (typeof value === 'string') return expandCredentialRefs(value, resolver, options)
  if (Array.isArray(value)) {
    const items: unknown[] = []
    for (const item of value) items.push(await expandCredentialRefsDeep(item, resolver, options))
    return items
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      result[key] = await expandCredentialRefsDeep(item, resolver, options)
    }
    return result
  }
  return value
}

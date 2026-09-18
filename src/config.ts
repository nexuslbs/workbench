import fs from 'node:fs'
import path from 'node:path'
import type { WorkbenchConfig } from './types.ts'

/** Default config file name, looked up in the working directory. */
export const DEFAULT_CONFIG_FILE = 'workbench.config.json'

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

export function readConfig(configFile: string): ReadConfigResult {
  const file = path.resolve(configFile)
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown
  const config = expandEnvDeep(raw) as WorkbenchConfig
  if (!Array.isArray(config.sources)) throw new Error(`config ${file}: 'sources' must be an array`)
  for (const source of config.sources) {
    if (source.kind !== 'path' && source.kind !== 'git') {
      throw new Error(`config ${file}: source kind must be 'path' or 'git' (got ${String(source.kind)})`)
    }
    if (source.kind === 'path' && !source.path) throw new Error(`config ${file}: a 'path' source needs a 'path'`)
    if (source.kind === 'git' && !source.url) throw new Error(`config ${file}: a 'git' source needs a 'url'`)
  }
  return { config, dir: path.dirname(file), file }
}

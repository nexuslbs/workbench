import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import type { SourceSpec } from './types.ts'

/** A source spec resolved to the directory that holds the plugin directories. */
export interface ResolvedSource {
  id: string
  kind: SourceSpec['kind']
  /** Plugin directory, or null when the source could not be resolved. */
  dir: string | null
  /** Set when the source could not be resolved (missing path, git failure, ...). */
  error?: string
  external: boolean
}

function repoName(url: string): string {
  return path.basename(url).replace(/\.git$/, '')
}

/** Resolves a source spec to a directory. Never throws: resolution errors are reported. */
export function resolveSource(spec: SourceSpec, configDir: string, cacheRoot: string): ResolvedSource {
  const external = spec.external !== false
  if (spec.kind === 'path') {
    const dir = path.resolve(configDir, spec.path ?? '')
    const id = spec.id ?? path.basename(dir)
    if (!fs.existsSync(dir)) return { id, kind: 'path', dir: null, error: `path source directory does not exist: ${dir}`, external }
    return { id, kind: 'path', dir, external }
  }

  const id = spec.id ?? repoName(spec.url ?? 'unknown')
  const checkout = path.join(cacheRoot, id)
  try {
    ensureGitCheckout(spec, checkout)
  } catch (error) {
    return { id, kind: 'git', dir: null, error: (error as Error).message, external }
  }
  const dir = spec.subdir ? path.join(checkout, spec.subdir) : checkout
  if (!fs.existsSync(dir)) return { id, kind: 'git', dir: null, error: `git source subdir does not exist: ${dir}`, external }
  return { id, kind: 'git', dir, external }
}

function ensureGitCheckout(spec: SourceSpec, checkout: string): void {
  const git = (args: string[], cwd?: string): string => {
    const result = spawnSync('git', args, { encoding: 'utf8', ...(cwd ? { cwd } : {}) })
    if (result.error) throw new Error(`git is required for git plugin sources: ${result.error.message}`)
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(result.stderr || '').trim()}`)
    return (result.stdout ?? '').trim()
  }
  if (!fs.existsSync(path.join(checkout, '.git'))) {
    fs.mkdirSync(path.dirname(checkout), { recursive: true })
    git(['clone', '--depth', '1', ...(spec.ref ? ['--branch', spec.ref] : []), spec.url as string, checkout])
    return
  }
  git(['fetch', '--depth', '1', 'origin', spec.ref ?? 'HEAD'], checkout)
  git(['checkout', '--detach', 'FETCH_HEAD'], checkout)
}

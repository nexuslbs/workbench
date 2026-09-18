/**
 * Plugin SOURCE resolution: a configured source spec (`kind: path` or
 * `kind: git`) becomes the directory that holds the plugin directories.
 *
 * `git` sources are checked out into the cache root (`WORKBENCH_CACHE_DIR`,
 * default `<config dir>/.workbench/sources/<id>`) with a SHALLOW fetch, so the
 * host never depends on a pre-existing local checkout and never vendors plugin
 * source into the core. The contract of this module:
 *
 * - `ref` accepts a BRANCH, a TAG or a COMMIT SHA (the sha is resolved through
 *   the remote; a server that refuses to serve a sha directly falls back to a
 *   full fetch, which also covers tags behind annotated refs),
 * - `subdir` selects the plugin subtree of the repository,
 * - a source that declares `auth` is fetched with a TRANSIENT credential, handed
 *   to the single git invocation as `-c http.extraheader=...` + an empty
 *   `credential.helper` (see `src/source-auth.ts`): the value is never written
 *   into the checkout, the remote url stays the configured url, and a source
 *   whose credential could NOT be resolved is reported as an error and skipped -
 *   never silently fetched anonymously,
 * - a FIRST clone is staged in a temporary directory next to the target and
 *   moved into place with a single `rename`, so a failed/timed-out clone can
 *   never leave a half-populated source that would be scanned (or silently
 *   serve partial code). A leftover directory that is not a git checkout is
 *   removed before cloning, for the same reason,
 * - an UPDATE is an in-place `fetch` + forced detached `checkout` of the same
 *   ref. When the update fails the source is reported as an ERROR and the
 *   loader SKIPS it entirely, so stale code is never served silently,
 * - every failure message NAMES the source (id + url + ref) and carries git's
 *   own stderr, so "which source is broken and why" is answerable from the log.
 *
 * Resolution never throws: errors are reported on the resolved source, which is
 * what makes a broken source a loud, isolated failure instead of a crash.
 */
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

/**
 * The outcome of authenticating a `git` source: TRANSIENT git arguments (never a
 * persisted credential), or an error naming what is missing. Produced by
 * `src/source-auth.ts` before any fetch and consumed by {@link resolveSource}.
 */
export type SourceAuthOutcome =
  | { ok: true; args: string[]; mechanism: string; credential: string; provider: string }
  | { ok: false; error: string }

/**
 * Stable source id (`id` from the config, else the directory/repository name).
 * Exported because source AUTH is resolved per source BEFORE the fetch, and the
 * keys must be exactly the ids the loader reports.
 */
export function sourceId(spec: SourceSpec, configDir: string = process.cwd()): string {
  if (spec.kind === 'path') return spec.id ?? path.basename(path.resolve(configDir, spec.path ?? ''))
  return spec.id ?? repoName(spec.url ?? 'unknown')
}

/** Git binary to run (`WORKBENCH_GIT` overrides it; default `git` from PATH). */
function gitBinary(): string {
  const fromEnv = process.env.WORKBENCH_GIT?.trim()
  return fromEnv && fromEnv.length > 0 ? fromEnv : 'git'
}

interface GitResult {
  ok: boolean
  stdout: string
  stderr: string
  /** True when the git binary itself could not be run (ENOENT). */
  missing: boolean
}

/** Runs git; never throws (a missing binary and a non-zero exit are results). */
function git(args: string[], cwd?: string): GitResult {
  // `GIT_TERMINAL_PROMPT=0`: a missing/refused credential must FAIL (and be
  // reported on the source) instead of blocking on a prompt nobody answers.
  const result = spawnSync(gitBinary(), args, {
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    ...(cwd ? { cwd } : {}),
  })
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code
    return { ok: false, stdout: '', stderr: result.error.message, missing: code === 'ENOENT' }
  }
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? '').trim(),
    stderr: (result.stderr ?? '').trim(),
    missing: false,
  }
}

function repoName(url: string): string {
  return path.basename(url).replace(/\.git$/, '')
}

/** `source '<id>' (git <url> @ <ref>)`: every git message names the source. */
function label(id: string, spec: SourceSpec, ref?: string): string {
  const coordinates = [spec.url ?? '(no url)', ...(ref ? [ref] : [])].join(' @ ')
  return `source '${id}' (git ${coordinates})`
}

/**
 * Renders git args for a message with any `http.extraheader` value replaced by
 * `<redacted>`: a source credential is TRANSIENT and must never reach a log, an
 * error message or a report.
 */
export function redactArgs(args: readonly string[]): string[] {
  return args.map((arg) => (/extraheader=/i.test(arg) ? arg.replace(/=.*$/, '=<redacted>') : arg))
}

/** Runs git and throws a source-naming error when it fails. */
function required(id: string, spec: SourceSpec, args: string[], cwd: string | undefined, ref: string | undefined, why?: string): string {
  const result = git(args, cwd)
  if (result.missing) {
    throw new Error(
      `${label(id, spec, ref)}: git is required for 'git' plugin sources but could not be run ` +
        `('${gitBinary()}' not found in PATH); install git or point WORKBENCH_GIT at it`,
    )
  }
  if (!result.ok) {
    throw new Error(`${label(id, spec, ref)}${why ? `: ${why}` : ''}: git ${redactArgs(args).join(' ')} failed: ${result.stderr || '(no output)'}`)
  }
  return result.stdout
}

/** True when the directory is an existing git checkout (worktree present). */
function isGitCheckout(dir: string): boolean {
  return fs.existsSync(path.join(dir, '.git'))
}

/**
 * Fetches `ref` (branch / tag / sha, default the remote HEAD) into `dir` and
 * leaves the worktree at that commit, detached.
 *
 * The shallow fetch is the fast path. It is retried ONCE as a full fetch
 * (`--tags --force`) when it fails, which is what makes a raw COMMIT SHA - or a
 * tag the server will not serve shallowly - resolvable; when that fails too the
 * ref really is unresolvable and the error names it.
 */
function fetchAndCheckout(
  id: string,
  spec: SourceSpec,
  url: string,
  ref: string | undefined,
  dir: string,
  auth: readonly string[] = [],
): void {
  const target = ref ?? 'HEAD'
  const shallow = git([...auth, 'fetch', '--depth', '1', 'origin', target], dir)
  if (shallow.ok) {
    required(id, spec, ['checkout', '--force', '--detach', 'FETCH_HEAD'], dir, ref)
    return
  }
  if (shallow.missing) {
    required(id, spec, [...auth, 'fetch', '--depth', '1', 'origin', target], dir, ref)
    return
  }
  required(id, spec, [...auth, 'fetch', '--tags', '--force', 'origin'], dir, ref, `cannot fetch ref '${target}' (git said: ${shallow.stderr || 'no output'})`)
  const revision = ref ?? 'FETCH_HEAD'
  const resolved = git(['rev-parse', '--verify', '--quiet', `${revision}^{commit}`], dir)
  if (!resolved.ok || resolved.stdout.length === 0) {
    throw new Error(`${label(id, spec, ref)}: cannot resolve ref '${target}' in ${url} (no such branch, tag or commit)`)
  }
  required(id, spec, ['checkout', '--force', '--detach', revision], dir, ref)
}

/** Points `origin` at the configured url (a moved source must not fetch the old one). */
function syncRemote(id: string, spec: SourceSpec, url: string, ref: string | undefined, dir: string): void {
  const current = git(['remote', 'get-url', 'origin'], dir)
  if (!current.ok) {
    required(id, spec, ['remote', 'add', 'origin', url], dir, ref)
    return
  }
  if (current.stdout !== url) required(id, spec, ['remote', 'set-url', 'origin', url], dir, ref)
}

/**
 * Makes `checkout` hold the configured source: first use clones into a staging
 * directory and moves it into place atomically, later runs update in place.
 */
function ensureGitCheckout(spec: SourceSpec, checkout: string, id: string, auth: readonly string[] = []): void {
  const url = typeof spec.url === 'string' ? spec.url.trim() : ''
  if (url.length === 0) throw new Error(`source '${id}': a 'git' source needs a 'url' (kind: git, url: <repository>)`)
  const ref = typeof spec.ref === 'string' && spec.ref.trim().length > 0 ? spec.ref.trim() : undefined

  if (isGitCheckout(checkout)) {
    syncRemote(id, spec, url, ref, checkout)
    fetchAndCheckout(id, spec, url, ref, checkout, auth)
    return
  }

  // A directory that is not a git checkout is the remains of an interrupted
  // clone: remove it, so nothing half-populated can ever be scanned.
  if (fs.existsSync(checkout)) fs.rmSync(checkout, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(checkout), { recursive: true })

  const staging = `${checkout}.staging-${process.pid}-${Date.now()}`
  fs.rmSync(staging, { recursive: true, force: true })
  try {
    fs.mkdirSync(staging, { recursive: true })
    required(id, spec, ['init', '--quiet'], staging, ref)
    required(id, spec, ['remote', 'add', 'origin', url], staging, ref)
    fetchAndCheckout(id, spec, url, ref, staging, auth)
    fs.renameSync(staging, checkout)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }
}

/** Resolves a source spec to a directory. Never throws: resolution errors are reported. */
export function resolveSource(
  spec: SourceSpec,
  configDir: string,
  cacheRoot: string,
  auth?: SourceAuthOutcome,
): ResolvedSource {
  const external = spec.external !== false
  if (spec.kind === 'path') {
    const dir = path.resolve(configDir, spec.path ?? '')
    const id = sourceId(spec, configDir)
    if (!fs.existsSync(dir)) return { id, kind: 'path', dir: null, error: `path source directory does not exist: ${dir}`, external }
    return { id, kind: 'path', dir, external }
  }

  const id = sourceId(spec, configDir)
  const checkout = path.join(cacheRoot, id)
  // A source that DECLARES auth is never fetched without a resolved credential:
  // no anonymous retry, and no stale checkout served silently either.
  if (spec.auth !== undefined && auth === undefined) {
    return {
      id,
      kind: 'git',
      dir: null,
      error: `${label(id, spec, spec.ref)}: this source declares 'auth' but no credential was resolved for it (the loader must resolve source auth before fetching)`,
      external,
    }
  }
  if (auth !== undefined && !auth.ok) {
    return { id, kind: 'git', dir: null, error: `${label(id, spec, spec.ref)}: authentication failed: ${auth.error}`, external }
  }
  try {
    ensureGitCheckout(spec, checkout, id, auth?.ok ? auth.args : [])
  } catch (error) {
    return { id, kind: 'git', dir: null, error: (error as Error).message, external }
  }
  const dir = spec.subdir ? path.join(checkout, spec.subdir) : checkout
  if (!fs.existsSync(dir)) {
    return {
      id,
      kind: 'git',
      dir: null,
      error: `${label(id, spec, spec.ref)}: git source subdir does not exist: ${dir} (checkout ${checkout})`,
      external,
    }
  }
  return { id, kind: 'git', dir, external }
}

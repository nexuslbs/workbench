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
 * - the resolved COMMIT of a checkout and the files under it are registered as
 *   ONE module graph (`src/module-graph.ts`), so a ref bump or a re-checkout
 *   invalidates the whole graph of that source and the NEW code is imported
 *   without a restart,
 * - the DEPENDENCIES a checkout declares (`package.json` + lockfile) are
 *   provisioned right after the checkout lands, through the package manager the
 *   lockfile names, and a failing install is reported as a typed diagnostic that
 *   names the exact command - never a silent `provider-unavailable` later,
 * - every failure message NAMES the source (id + url + ref) and carries git's
 *   own stderr, so "which source is broken and why" is answerable from the log.
 *
 * Resolution never throws: errors are reported on the resolved source, which is
 * what makes a broken source a loud, isolated failure instead of a crash.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { packageRootOf, registerSourceGraph } from './module-graph.ts'
import type { SourceSpec } from './types.ts'

/**
 * What happened to a checkout's DEPENDENCIES during source resolution. Reported
 * on the resolved source (and on the source report the loader/host render), so
 * "are the dependencies of this source installed?" is answerable without
 * reading the operator's shell history.
 */
export interface DependencyProvisionReport {
  /** Package manager the checkout declares (`npm` / `pnpm` / `yarn`). */
  manager: string
  /** The exact command that was run (and that an operator can run by hand). */
  command: string
  /** Directory the command runs in (the checkout root). */
  dir: string
  /** `provisioned` = installed now, `cached` = inputs unchanged, `skipped` = disabled, `failed` = install failed. */
  status: 'provisioned' | 'cached' | 'skipped' | 'failed'
  /** Set when the install failed or was disabled: the typed diagnostic, naming the command. */
  error?: string
}

/** A source spec resolved to the directory that holds the plugin directories. */
export interface ResolvedSource {
  id: string
  kind: SourceSpec['kind']
  /** Plugin directory, or null when the source could not be resolved. */
  dir: string | null
  /** Set when the source could not be resolved (missing path, git failure, ...). */
  error?: string
  external: boolean
  /** Git sources only: the dependency provisioning outcome (absent when the source declares no package.json). */
  dependencies?: DependencyProvisionReport
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

/**
 * Where the DEPENDENCY MARKER of a checkout lives: NEXT TO it, never inside it,
 * so `checkout --force` cannot delete it and no plugin scan can ever see it (a
 * source scans the plugin directories of its own tree only).
 */
function dependencyMarker(checkout: string): string {
  return `${checkout}.deps.json`
}

/** How long one dependency install may take before it is reported as a failure. */
const DEPENDENCY_INSTALL_TIMEOUT_MS = 900_000

/**
 * The package manager a checkout declares, from its LOCKFILE (npm by default),
 * with the binary overridable through the environment (`WORKBENCH_NPM`,
 * `WORKBENCH_PNPM`, `WORKBENCH_YARN`) - the same escape hatch `WORKBENCH_GIT`
 * gives the git side, and what makes this step testable without a network.
 */
function installPlan(root: string): { manager: string; command: string[]; text: string } | null {
  if (!fs.existsSync(path.join(root, 'package.json'))) return null
  const has = (file: string): boolean => fs.existsSync(path.join(root, file))
  const binary = (name: string, variable: string): string => {
    const fromEnv = process.env[variable]?.trim()
    return fromEnv && fromEnv.length > 0 ? fromEnv : name
  }
  if (has('pnpm-lock.yaml')) {
    return { manager: 'pnpm', command: [binary('pnpm', 'WORKBENCH_PNPM'), 'install', '--frozen-lockfile', '--prod'], text: 'pnpm install --frozen-lockfile --prod' }
  }
  if (has('yarn.lock')) {
    return { manager: 'yarn', command: [binary('yarn', 'WORKBENCH_YARN'), 'install', '--frozen-lockfile', '--production=true'], text: 'yarn install --frozen-lockfile --production=true' }
  }
  const npm = binary('npm', 'WORKBENCH_NPM')
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) {
    return { manager: 'npm', command: [npm, 'ci', '--omit=dev'], text: 'npm ci --omit=dev' }
  }
  return { manager: 'npm', command: [npm, 'install', '--omit=dev'], text: 'npm install --omit=dev' }
}

/**
 * The dependency INPUTS of a checkout: `package.json` plus every lockfile shape
 * this module understands, as `name:size:mtime` lines. A moved lockfile - or a
 * changed manifest - is what makes an install necessary again.
 */
function dependencyInputs(root: string): string {
  return ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']
    .map((file) => {
      try {
        const stat = fs.statSync(path.join(root, file))
        return `${file}:${stat.size}:${Math.round(stat.mtimeMs)}`
      } catch {
        return `${file}:absent`
      }
    })
    .join('|')
}

/** The marker of the last SUCCESSFUL install, or `undefined` when there is none. */
function readDependencyMarker(file: string): { manager?: string; inputs?: string } | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { manager?: string; inputs?: string }
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * Provisions the DEPENDENCIES of a git source's checkout: the deterministic step
 * between "the code is here" and "the code can be imported".
 *
 * It runs the package manager the lockfile names (`npm ci --omit=dev` for an
 * npm checkout, frozen installs for pnpm/yarn) in the CHECKOUT ROOT - the only
 * directory a plugin's `node_modules` lookup can reach - and it is IDEMPOTENT:
 * a marker next to the checkout records the dependency INPUTS of the last
 * successful install, so a source with its dependencies in place installs
 * nothing on the next boot (offline-safe after the first successful run) while a
 * changed lockfile, a missing `node_modules` or a fresh checkout install again.
 *
 * FAILURE IS TYPED AND LOUD: the returned report carries
 * `source-dependencies-unavailable` plus the EXACT command and directory, so
 * "why is this provider unavailable" is answerable from the log instead of
 * surfacing later as a silent `provider-unavailable` inside one plugin.
 * `WORKBENCH_SOURCE_INSTALL=off` is the explicit opt-out (reported as `skipped`,
 * never as a silent success).
 */
function provisionDependencies(id: string, spec: SourceSpec, checkout: string, ref: string | undefined): DependencyProvisionReport | undefined {
  const plan = installPlan(checkout)
  if (plan === null) return undefined
  const inputs = dependencyInputs(checkout)
  const markerFile = dependencyMarker(checkout)
  const installed = fs.existsSync(path.join(checkout, 'node_modules'))
  const previous = readDependencyMarker(markerFile)
  if (installed && previous?.manager === plan.manager && previous?.inputs === inputs) {
    return { manager: plan.manager, command: plan.text, dir: checkout, status: 'cached' }
  }
  if ((process.env.WORKBENCH_SOURCE_INSTALL ?? '').trim().toLowerCase() === 'off') {
    return {
      manager: plan.manager,
      command: plan.text,
      dir: checkout,
      status: 'skipped',
      error: `${label(id, spec, ref)}: source-dependencies-skipped: dependency provisioning is disabled (WORKBENCH_SOURCE_INSTALL=off); run '${plan.text}' in ${checkout} if this source needs its dependencies`,
    }
  }
  const result = spawnSync(plan.command[0], plan.command.slice(1), {
    cwd: checkout,
    encoding: 'utf8',
    // npm reads a few of its own knobs from the environment: no audit/fund
    // network round-trips, and CI=1 makes the manager non-interactive.
    env: { ...process.env, CI: '1', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' },
    timeout: DEPENDENCY_INSTALL_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
  })
  if (result.error || result.status !== 0) {
    const raw = (result.error?.message ?? result.stderr ?? result.stdout ?? '').trim()
    const detail = raw.split('\n').filter((line) => line.trim().length > 0).slice(-4).join(' ').slice(0, 400)
    return {
      manager: plan.manager,
      command: plan.text,
      dir: checkout,
      status: 'failed',
      error:
        `${label(id, spec, ref)}: source-dependencies-unavailable: '${plan.text}' failed in ${checkout}${detail ? ` (${detail})` : ''}; ` +
        `run '${plan.text}' in ${checkout} by hand, or set WORKBENCH_SOURCE_INSTALL=off to load the source without its dependencies`,
    }
  }
  fs.writeFileSync(markerFile, `${JSON.stringify({ manager: plan.manager, inputs, command: plan.text, at: new Date().toISOString() }, null, 2)}\n`)
  return { manager: plan.manager, command: plan.text, dir: checkout, status: 'provisioned' }
}

/** The resolved commit of a checkout (its module-graph version), or null when git cannot tell. */
function checkoutCommit(checkout: string): string | null {
  const result = git(['rev-parse', 'HEAD'], checkout)
  return result.ok && result.stdout.length > 0 ? result.stdout : null
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
    // A path source is a module GRAPH too: the package root that holds it is
    // registered, so a helper shared ABOVE the plugin tree (`definitions/` next
    // to `plugins/`) is part of the same identity as the plugins that import it.
    registerSourceGraph(packageRootOf(dir))
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
  // The checkout landed: its COMMIT plus the files under it define the module
  // graph of this source, so a ref bump (or any in-place re-checkout) makes the
  // loader import the NEW code as a whole - entries AND helpers - instead of
  // meeting a helper cached from the previous checkout.
  registerSourceGraph(checkout, { commit: checkoutCommit(checkout) })
  const dependencies = provisionDependencies(id, spec, checkout, spec.ref)
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
  return dependencies === undefined ? { id, kind: 'git', dir, external } : { id, kind: 'git', dir, external, dependencies }
}

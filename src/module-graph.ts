/**
 * MODULE GRAPH IDENTITY - the loader's answer to Node's ESM cache.
 *
 * Node caches an ES module by its URL for the whole life of the process, and a
 * query string does NOT take part in module RESOLUTION: a relative specifier is
 * resolved against the parent's DIRECTORY (the parent's query is dropped), so a
 * plugin entry imported as `.../index.ts?wb=<id>` still imports its helpers
 * (`./shared.ts`, `../../definitions/browser-use.ts`) under PLAIN `file://`
 * URLs, and those plain URLs are served from the cache for the life of the
 * process.
 *
 * That is exactly what broke a LIVE source swap (production omni-stack,
 * 2026-09-20): the plugins checkout was moved v0.0.7 -> v0.0.8 UNDER the running
 * process, the NEW plugin entries were imported, and a shared helper they import
 * (`../../definitions/browser-use.ts`) kept resolving to the STALE module, so the
 * link step failed with `does not provide an export named 'CHALLENGE_ACTIONS'`.
 * A fresh process imported the same files fine, and reverting the config did NOT
 * heal the poisoned process - only a restart did.
 *
 * THE FIX: ONE IDENTITY PER SOURCE GRAPH, applied by a loader-owned RESOLVE HOOK
 * to EVERY module resolved inside a registered source root - the entry AND its
 * helpers, at any depth, whatever relative path a plugin uses. A graph is a
 * source root plus the identity of the code under it:
 *
 *   - the RESOLVED COMMIT of the checkout (`git rev-parse HEAD`), so bumping a
 *     source `ref` (or any in-place re-checkout) invalidates that source's whole
 *     graph,
 *   - a FINGERPRINT of the tree (relative path + size + content digest of every
 *     file, `node_modules` and `.git` excluded), so an edit ON DISK is picked up
 *     too - a CONTENT digest, not a timestamp, so an in-place edit that keeps the
 *     file SIZE moves the identity even on a filesystem with coarse mtimes,
 *   - a bounded summary of the PROVISIONED dependencies (`node_modules` top level
 *     plus npm's own `.package-lock.json`), so provisioning or removing a
 *     dependency moves the identity as well.
 *
 * FRESHNESS CONTRACT (what the operator can rely on):
 *   - the identity is recomputed EVERY time a plugin entry is imported (`moduleUrl`),
 *     so an edited file is read again on the next load - the historical
 *     "a code-level patch reaches a running process" contract, unchanged;
 *   - helpers are decorated with the identity PINNED by that entry import, so one
 *     load sees ONE version of the graph: new entry + STALE helper is impossible;
 *   - an UNCHANGED source keeps the SAME identity and therefore the SAME URLs
 *     (every module stays in the cache: no re-evaluation, no module-map growth),
 *     while a CHANGED one moves them all at once;
 *   - `driftedSourceGraphs()` reports the sources whose LOADED code no longer
 *     matches the code on disk, which is how a reconcile re-imports them without a
 *     config edit and without a restart.
 *
 * DELIBERATE SCOPE: modules under a `node_modules` directory are NEVER decorated
 * (and never fingerprinted): dependencies are provisioned from the lockfile (see
 * `sources.ts`), their URLs stay stable, and the well-known dependency loading
 * path (CJS interop included) is untouched. A helper OUTSIDE every registered
 * root inherits the identity of the module that imported it, so a plugin tree
 * whose shared helpers live above the source directory is still coherent.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import * as nodeModule from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** The query parameter carrying the identity. */
export const GRAPH_QUERY = 'wb'

/** Directories never walked for the tree fingerprint. */
const SKIP_DIRS = new Set(['node_modules', '.git'])

/** How many parent directories a path source may climb to find its package root. */
const MAX_PACKAGE_CLIMB = 4

/** One registered source graph: a root directory plus the identity of its code. */
interface SourceGraph {
  /** Absolute root whose tree defines the identity. */
  root: string
  /** Resolved commit of the checkout, when the source is git (`null` otherwise). */
  commit: string | null
  /** Identity used when an entry of this graph was last imported (`null` before that). */
  imported: string | null
  /** Identity the resolve hook decorates helpers with (pinned by the last entry import). */
  pinned: string | null
}

const graphs = new Map<string, SourceGraph>()
let hookInstalled = false

/** Public shape of a registered graph (introspection, reports and tests). */
export interface SourceGraphInfo {
  root: string
  commit: string | null
  /** Identity the code on disk has RIGHT NOW. */
  identity: string
  /** Identity of the code that is LOADED (`null` when no entry has been imported). */
  imported: string | null
}

function hash(parts: readonly string[]): string {
  return crypto.createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 12)
}

/**
 * The files of a source tree, as sorted `relative path:size:digest` lines.
 * `node_modules` and `.git` are skipped: dependencies are summarised separately
 * and a git checkout's committed content is already represented by its commit.
 *
 * The digest is a CONTENT hash, not a timestamp: an in-place edit that keeps the
 * file size (a one-line helper change, exactly the production case) must move the
 * identity even on a filesystem whose mtime granularity equals the write window.
 */
function treeFingerprint(root: string): string[] {
  const lines: string[] = []
  const stack: string[] = [root]
  while (stack.length > 0) {
    const dir = stack.pop() as string
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(full)
        continue
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      lines.push(`${path.relative(root, full)}:${stat.size}:${fileDigest(full, stat)}`)
    }
  }
  lines.sort()
  return lines
}

/** Above this size a file is identified by its stamp instead of being hashed. */
const MAX_HASHED_FILE_BYTES = 2 * 1024 * 1024

/**
 * The content digest of one file of a source tree. A source file is small (the
 * fingerprint exists to catch a code patch), so it is READ; a bigger file - or an
 * unreadable one - falls back to its size/mtime stamp instead of failing the walk.
 */
function fileDigest(file: string, stat: fs.Stats): string {
  if (stat.size > MAX_HASHED_FILE_BYTES) return `stamp:${stat.size}:${stat.mtimeMs}`
  try {
    return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10)
  } catch {
    return `unreadable:${stat.size}:${stat.mtimeMs}`
  }
}

/**
 * A bounded summary of the PROVISIONED dependencies: the top level of
 * `node_modules` plus npm's own `.package-lock.json`. An install, a removal or an
 * installed version change all move it, without walking the dependency tree.
 */
function dependencyFingerprint(root: string): string {
  const modules = path.join(root, 'node_modules')
  let names: string[]
  try {
    names = fs.readdirSync(modules).sort()
  } catch {
    return 'absent'
  }
  const stamp = (file: string): string => {
    try {
      const stat = fs.statSync(file)
      return `${stat.size}:${Math.round(stat.mtimeMs)}`
    } catch {
      return 'missing'
    }
  }
  return hash([...names.map((name) => `${name}:${stamp(path.join(modules, name))}`), `.package-lock.json:${stamp(path.join(modules, '.package-lock.json'))}`])
}

/**
 * The identity of a source root's code: the resolved commit (when git) plus the
 * fingerprint of the tree and of the provisioned dependencies. Purely a function
 * of what is ON DISK right now - never cached, so the caller always sees the
 * current state.
 */
function computeIdentity(root: string, commit: string | null): string {
  const version = commit === null ? 'worktree' : commit.slice(0, 8)
  return `${version}-${hash([...treeFingerprint(root), `deps:${dependencyFingerprint(root)}`])}`
}

/** True for any path segment named `node_modules` (never decorated, never walked). */
function underNodeModules(file: string): boolean {
  return file.split(path.sep).includes('node_modules')
}

/** The most specific registered graph containing `file` (longest root wins). */
function graphOf(file: string): SourceGraph | undefined {
  let best: SourceGraph | undefined
  for (const graph of graphs.values()) {
    if (file !== graph.root && !file.startsWith(graph.root + path.sep)) continue
    if (best === undefined || graph.root.length > best.root.length) best = graph
  }
  return best
}

/** The identity a parent URL carries, when the loader already decorated it. */
function identityOfParent(parentUrl: string | undefined): string | undefined {
  if (parentUrl === undefined || !parentUrl.startsWith('file:')) return undefined
  try {
    const parsed = new URL(parentUrl)
    const value = parsed.searchParams.get(GRAPH_QUERY)
    if (value === null || value.length === 0) return undefined
    if (underNodeModules(fileURLToPath(parentUrl))) return undefined
    return value
  } catch {
    return undefined
  }
}

/**
 * The URL a resolved import should use: the identity of the graph the target
 * belongs to, else the identity of the module that imported it. A URL that is
 * already decorated (or that carries no identity at all) is returned untouched,
 * so the hook is a no-op for the core, for dependencies and for every import
 * before the first source graph is registered.
 */
function decorate(url: string, parentUrl: string | undefined): string {
  if (graphs.size === 0 && parentUrl === undefined) return url
  if (!url.startsWith('file:')) return url
  let file: string
  try {
    file = fileURLToPath(url)
  } catch {
    return url
  }
  if (underNodeModules(file)) return url
  const graph = graphOf(file)
  const identity = graph !== undefined ? (graph.pinned ?? undefined) : identityOfParent(parentUrl)
  if (identity === undefined) return url
  const parsed = new URL(url)
  if (parsed.searchParams.get(GRAPH_QUERY) === identity) return url
  parsed.searchParams.set(GRAPH_QUERY, identity)
  return parsed.href
}

/**
 * Installs the loader's RESOLVE hook once per process: every module URL that
 * resolves inside a registered source root (or that a decorated module imports)
 * carries the identity of its graph.
 */
function installResolverHook(): void {
  if (hookInstalled) return
  const api = nodeModule as unknown as {
    registerHooks?: (hooks: {
      resolve: (
        specifier: string,
        context: { parentURL?: string },
        nextResolve: (specifier: string, context: unknown) => { url: string; format?: string },
      ) => { url: string; format?: string }
    }) => void
  }
  if (typeof api.registerHooks !== 'function') {
    throw new Error(
      `this runtime (${process.version}) has no module.registerHooks (Node >= 22.15): a plugin source could not be re-imported freshly ` +
        'after a live checkout swap, so a STALE helper module would be served - refusing to run on an ESM cache that cannot be busted',
    )
  }
  api.registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context)
      try {
        const url = decorate(resolved.url, context.parentURL)
        return url === resolved.url ? resolved : { ...resolved, url }
      } catch {
        // A resolver only decorates: it never fails the import it resolves.
        return resolved
      }
    },
  })
  hookInstalled = true
}

/**
 * The nearest ancestor of `dir` that is a PACKAGE (a directory holding a
 * `package.json`), climbing at most {@link MAX_PACKAGE_CLIMB} levels. A path
 * source that points INTO a repository (`.../plugins`) is fingerprinted at the
 * repository root, so the shared helpers that live next to the plugin tree are
 * part of the same graph. Falls back to `dir` itself.
 */
export function packageRootOf(dir: string): string {
  let current = path.resolve(dir)
  for (let level = 0; level < MAX_PACKAGE_CLIMB; level += 1) {
    const parent = path.dirname(current)
    if (parent === current) break
    if (!fs.existsSync(path.join(parent, 'package.json'))) break
    current = parent
  }
  return current
}

/**
 * Registers (or refreshes) a source graph: the root whose modules share one
 * identity. Called by source resolution, so the boot walk and every host action
 * register the graph of the source they just resolved - `commit` is the resolved
 * git commit of a checkout, absent for a plain directory. A filesystem root is
 * never registered (it would put every module of the process in one graph).
 */
export function registerSourceGraph(root: string, options: { commit?: string | null } = {}): void {
  const resolved = path.resolve(root)
  if (resolved === path.parse(resolved).root) return
  const commit = typeof options.commit === 'string' && options.commit.length > 0 ? options.commit : null
  const existing = graphs.get(resolved)
  if (existing !== undefined) {
    existing.commit = commit
  } else {
    graphs.set(resolved, { root: resolved, commit, imported: null, pinned: null })
  }
  installResolverHook()
}

/** Forgets a source graph (its modules keep whatever URLs they already have). */
export function unregisterSourceGraph(root: string): void {
  graphs.delete(path.resolve(root))
}

/**
 * The URL a plugin ENTRY module is imported from: the file URL decorated with the
 * identity of its source graph, RECOMPUTED here (this is the freshness point of a
 * load: an edited entry, an edited helper or a swapped checkout all move the
 * identity, so the whole graph is read again). The identity is PINNED for the
 * load that follows, so every helper the entry imports is decorated with the very
 * same value - a new entry can never meet a stale helper.
 *
 * A file outside every registered graph keeps the historical per-FILE identity
 * (`mtime-size`), so a plugin loaded from an unregistered directory behaves
 * exactly as before.
 */
export function moduleUrl(file: string): string {
  const absolute = path.resolve(file)
  const url = pathToFileURL(absolute)
  const graph = graphOf(absolute)
  if (graph === undefined) {
    const stat = fs.statSync(absolute)
    url.searchParams.set(GRAPH_QUERY, `${stat.mtimeMs}-${stat.size}`)
    return url.href
  }
  const identity = computeIdentity(graph.root, graph.commit)
  graph.pinned = identity
  graph.imported = identity
  url.searchParams.set(GRAPH_QUERY, identity)
  return url.href
}

/** The root of the source graph a file belongs to (the registration key). */
export function sourceGraphRootOf(file: string): string | undefined {
  return graphOf(path.resolve(file))?.root
}

/** The identity the loader last PINNED for the graph a file belongs to. */
export function sourceGraphIdentityFor(file: string): string | undefined {
  return graphOf(path.resolve(file))?.pinned ?? undefined
}

/** Every registered source graph with the identity of the code on disk NOW. */
export function sourceGraphs(): SourceGraphInfo[] {
  return [...graphs.values()].map((graph) => ({
    root: graph.root,
    commit: graph.commit,
    identity: computeIdentity(graph.root, graph.commit),
    imported: graph.imported,
  }))
}

/**
 * The roots whose LOADED code no longer matches the code ON DISK: the sources a
 * reconcile has to re-import even when no roster row changed. A graph whose entry
 * was never imported is not a drift (nothing stale is being served), and neither
 * is a graph whose root no longer exists on disk. The scan does NOT pin the new
 * identity: the re-import does that, through {@link moduleUrl}.
 */
export function driftedSourceGraphs(): Set<string> {
  const drifted = new Set<string>()
  for (const graph of graphs.values()) {
    if (graph.imported === null) continue
    // A root that is GONE (a removed checkout, a scratch source) is not a drift:
    // there is no new code to re-import, and the source is reported as an error by
    // source resolution instead.
    if (!fs.existsSync(graph.root)) continue
    if (computeIdentity(graph.root, graph.commit) !== graph.imported) drifted.add(graph.root)
  }
  return drifted
}

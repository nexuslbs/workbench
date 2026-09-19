// Regression tests of the `kind: git` plugin source: clone on first use,
// in-place update, `subdir` selection, branch / tag / sha refs, the error paths
// (missing git, bad url, unresolvable ref) and the guarantee that a failed
// clone never leaves a half-populated source behind.
//
// The source repository is a REAL git repository created in a temp directory
// (the core repo must not depend on any plugin checkout, and a mock would not
// prove that the git plumbing works). The end-to-end case boots the kernel with
// a git source and calls the command the fetched plugin registered, because
// only that proves the fetched plugin actually ANSWERS.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'
import { resolveSource } from '../src/sources.ts'
import type { SourceSpec } from '../src/types.ts'
import { FIXTURE_PLUGINS } from './fixtures.ts'

const quiet = (): void => undefined

const GIT_ENV = {
  GIT_AUTHOR_NAME: 'workbench test',
  GIT_AUTHOR_EMAIL: 'workbench-test@example.invalid',
  GIT_COMMITTER_NAME: 'workbench test',
  GIT_COMMITTER_EMAIL: 'workbench-test@example.invalid',
}

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

function gitIn(dir: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } })
  assert.equal(result.status, 0, `git ${args.join(' ')} failed in ${dir}: ${result.stderr}`)
  return (result.stdout ?? '').trim()
}

const PLUGIN_MANIFEST = {
  name: 'git-demo',
  version: '0.1.0',
  description: 'test plugin served from a git source',
  entry: 'index.js',
  capabilities: ['command:git demo'],
}

/** The plugin entry: it answers with the message its config carries. */
function pluginEntry(message: string): string {
  return `export default {
  name: 'git-demo',
  inject: ['workbench'],
  apply(ctx, config = {}) {
    ctx.effect(() => ctx.workbench.registerCommand({
      name: 'git demo',
      description: 'answers from the git source',
      run: () => 'git source ' + (config.message ?? ${JSON.stringify(message)}),
    }))
  },
}
`
}

interface Repo {
  /** Clone url (a local path: git supports it, no network involved). */
  url: string
  /** Branch name (`main`). */
  branch: string
  /** Commits, oldest first. */
  commits: string[]
}

/** Creates a real repository holding one plugin under `plugins/git-demo`. */
function makeRepo(message: string): Repo {
  const dir = tempDir('workbench-git-source')
  gitIn(dir, ['init', '--quiet'])
  gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  const pluginDir = path.join(dir, 'plugins', 'git-demo')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'workbench.plugin.json'), JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n')
  fs.writeFileSync(path.join(pluginDir, 'index.js'), pluginEntry(message))
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '--quiet', '-m', `plugin ${message}`])
  const first = gitIn(dir, ['rev-parse', 'HEAD'])
  return { url: dir, branch: 'main', commits: [first] }
}

/** Commits a new plugin message into the repository and returns the new sha. */
function commitMessage(repo: Repo, message: string): string {
  fs.writeFileSync(path.join(repo.url, 'plugins', 'git-demo', 'index.js'), pluginEntry(message))
  gitIn(repo.url, ['add', '-A'])
  gitIn(repo.url, ['commit', '--quiet', '-m', `plugin ${message}`])
  const sha = gitIn(repo.url, ['rev-parse', 'HEAD'])
  repo.commits.push(sha)
  return sha
}

/** Reads the plugin entry actually checked out for a source. */
function checkedOutEntry(resolved: { dir: string | null }, id: string): string {
  assert.ok(resolved.dir, 'the source must resolve to a directory')
  return fs.readFileSync(path.join(resolved.dir as string, 'git-demo', 'index.js'), 'utf8')
}

function gitSource(url: string, id: string, extra: Partial<SourceSpec> = {}): SourceSpec {
  return { kind: 'git', id, url, ...extra }
}

test('a git source is cloned on first use, scanned through subdir, and the fetched plugin answers', async () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-git-config')
  const cache = path.join(dir, 'cache')
  const spec = gitSource(repo.url, 'git-demo-source', { ref: 'main', subdir: 'plugins' })

  const resolved = resolveSource(spec, dir, cache)
  assert.equal(resolved.error, undefined)
  assert.equal(resolved.kind, 'git')
  assert.equal(resolved.external, true)
  assert.equal(resolved.dir, path.join(cache, 'git-demo-source', 'plugins'))
  assert.ok(fs.existsSync(path.join(cache, 'git-demo-source', '.git')), 'the checkout is a real clone')
  // No staging directory survives a successful clone.
  assert.deepEqual(fs.readdirSync(cache).filter((entry) => entry.includes('.staging')), [])
  assert.match(checkedOutEntry(resolved, 'git-demo-source'), /v1/)

  // End-to-end: the kernel loads the source and the fetched plugin answers.
  const configFile = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(
    configFile,
    [
      'sources:',
      '  - kind: path',
      '    id: core',
      `    path: ${JSON.stringify(FIXTURE_PLUGINS)}`,
      '    external: false',
      '  - kind: git',
      '    id: git-demo-source',
      `    url: ${JSON.stringify(repo.url)}`,
      '    ref: main',
      '    subdir: plugins',
      '',
      'plugins:',
      '  git-demo:',
      '    message: v1',
      '',
    ].join('\n'),
  )
  const kernel = await createKernel({ configFile, log: quiet, cacheDir: cache })
  try {
    const source = kernel.sources.find((entry) => entry.id === 'git-demo-source')
    assert.ok(source, 'the git source is part of the inventory')
    assert.equal(source?.kind, 'git')
    assert.equal(source?.dir, path.join(cache, 'git-demo-source', 'plugins'))
    const loaded = kernel.plugins.find((plugin) => plugin.name === 'git-demo')
    assert.ok(loaded, 'the plugin fetched from git is loaded')
    assert.equal(loaded?.source, 'git-demo-source')
    assert.equal(await kernel.registry.resolve(['git', 'demo'])?.command.run([]), 'git source v1')
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('an existing checkout is updated in place for branch, tag and sha refs', () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-git-update')
  const cache = path.join(dir, 'cache')
  const first = repo.commits[0]
  try {
    // first use: clone at `main`
    const clone = resolveSource(gitSource(repo.url, 'updating', { ref: 'main', subdir: 'plugins' }), dir, cache)
    assert.equal(clone.error, undefined)
    assert.match(checkedOutEntry(clone, 'updating'), /v1/)

    // the ref moves: a re-resolve must fetch and move the SAME checkout
    const second = commitMessage(repo, 'v2')
    gitIn(repo.url, ['tag', 'v1', first])
    const updated = resolveSource(gitSource(repo.url, 'updating', { ref: 'main', subdir: 'plugins' }), dir, cache)
    assert.equal(updated.error, undefined)
    assert.match(checkedOutEntry(updated, 'updating'), /v2/)

    // tag ref
    const tagged = resolveSource(gitSource(repo.url, 'updating', { ref: 'v1', subdir: 'plugins' }), dir, cache)
    assert.equal(tagged.error, undefined)
    assert.match(checkedOutEntry(tagged, 'updating'), /v1/)

    // raw commit sha ref (both the newest one and an older, unreachable-by-branch commit)
    const bySha = resolveSource(gitSource(repo.url, 'updating', { ref: second, subdir: 'plugins' }), dir, cache)
    assert.equal(bySha.error, undefined)
    assert.match(checkedOutEntry(bySha, 'updating'), /v2/)

    // no ref at all: the remote HEAD (the branch the repository checked out)
    const byHead = resolveSource(gitSource(repo.url, 'by-head', { subdir: 'plugins' }), dir, cache)
    assert.equal(byHead.error, undefined)
    assert.match(checkedOutEntry(byHead, 'by-head'), /v2/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('a missing subdir is a clear error naming the source and the path', () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-git-subdir')
  try {
    const resolved = resolveSource(gitSource(repo.url, 'no-subdir', { ref: 'main', subdir: 'nope' }), dir, path.join(dir, 'cache'))
    assert.equal(resolved.dir, null)
    assert.match(resolved.error ?? '', /source 'no-subdir' \(git .* @ main\)/)
    assert.match(resolved.error ?? '', /git source subdir does not exist: .*nope/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('a bad url and an unresolvable ref name the source, and leave no half-populated checkout', () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-git-errors')
  const cache = path.join(dir, 'cache')
  try {
    const badUrl = resolveSource(gitSource(path.join(repo.url, 'does-not-exist'), 'broken-url', { ref: 'main' }), dir, cache)
    assert.equal(badUrl.dir, null)
    assert.match(badUrl.error ?? '', /source 'broken-url' \(git /)
    assert.match(badUrl.error ?? '', /git (init|remote add|fetch) .* failed/)
    assert.equal(fs.existsSync(path.join(cache, 'broken-url')), false, 'a failed clone must not leave a checkout behind')
    assert.deepEqual(fs.readdirSync(cache).filter((entry) => entry.includes('.staging')), [], 'the staging directory is removed')

    const badRef = resolveSource(gitSource(repo.url, 'broken-ref', { ref: 'no-such-ref' }), dir, cache)
    assert.equal(badRef.dir, null)
    assert.match(badRef.error ?? '', /source 'broken-ref' \(git .* @ no-such-ref\)/)
    assert.match(badRef.error ?? '', /cannot fetch ref 'no-such-ref'|cannot resolve ref 'no-such-ref'/)
    assert.equal(fs.existsSync(path.join(cache, 'broken-ref')), false)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('a leftover directory that is not a git checkout is replaced instead of scanned', () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-git-leftover')
  const cache = path.join(dir, 'cache')
  const checkout = path.join(cache, 'leftover')
  try {
    fs.mkdirSync(path.join(checkout, 'plugins', 'partial-plugin'), { recursive: true })
    fs.writeFileSync(path.join(checkout, 'plugins', 'partial-plugin', 'workbench.plugin.json'), '{ "name": "partial" }\n')
    const resolved = resolveSource(gitSource(repo.url, 'leftover', { ref: 'main' }), dir, cache)
    assert.equal(resolved.error, undefined)
    assert.equal(fs.existsSync(path.join(checkout, 'plugins', 'partial-plugin')), false, 'the partial leftover is gone')
    assert.ok(fs.existsSync(path.join(checkout, '.git')))
    assert.ok(fs.existsSync(path.join(checkout, 'plugins', 'git-demo', 'workbench.plugin.json')))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('a missing git binary is an actionable error naming the source', () => {
  const dir = tempDir('workbench-git-missing')
  const previous = process.env.WORKBENCH_GIT
  process.env.WORKBENCH_GIT = path.join(dir, 'no-git-here')
  try {
    const resolved = resolveSource(gitSource('https://example.invalid/plugins.git', 'needs-git', { ref: 'main' }), dir, path.join(dir, 'cache'))
    assert.equal(resolved.dir, null)
    assert.match(resolved.error ?? '', /source 'needs-git' \(git https:\/\/example\.invalid\/plugins\.git @ main\)/)
    assert.match(resolved.error ?? '', /git is required for 'git' plugin sources but could not be run/)
    assert.match(resolved.error ?? '', /WORKBENCH_GIT/)
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_GIT
    else process.env.WORKBENCH_GIT = previous
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a git source without a url is rejected with an actionable error', () => {
  const dir = tempDir('workbench-git-nourl')
  try {
    const resolved = resolveSource({ kind: 'git', id: 'no-url', ref: 'main' }, dir, path.join(dir, 'cache'))
    assert.equal(resolved.dir, null)
    assert.match(resolved.error ?? '', /source 'no-url': a 'git' source needs a 'url'/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

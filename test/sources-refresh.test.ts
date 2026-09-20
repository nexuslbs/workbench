// Regression tests of the FIRST-CLASS source refresh: `workbench sources
// update|list` (`host.refreshSources()`), the operation that UPDATES the remote
// plugin sources IN PLACE.
//
// What is pinned here (the operator's requirement, telegram thread 2657: "there
// is no single workbench command that updates the remote sources in place"):
//
//   * a refresh CLONES a source whose checkout is missing (no config edit, no
//     restart),
//   * a NEW COMMIT on the configured branch ref is picked up and the plugin that
//     came from that source answers with the NEW code - the module-graph drift
//     pass re-imports it under the RUNNING process,
//   * a config `ref` change (main -> another ref) checks THAT ref out in place,
//   * a second call with nothing new is IDEMPOTENT: `changed: false`, no
//     re-import, and the registered command function is the SAME object (proof
//     that no fiber was replaced),
//   * a REFRESH never writes the config file (`persisted: false`, same sha256),
//   * `list` only READS: it reports the checkout's commit and dependency state
//     without fetching (a new commit in the remote is NOT picked up by `list`),
//   * dependency provisioning of the checkout rides the refresh (`npm ci
//     --omit=dev` through the lockfile package manager - stubbed, no network),
//   * an unknown id and a `path` source are refused BY NAME (never guessed).
//
// The source repository is a REAL git repository in a temp directory: a mock
// would not prove that the fetch + forced detached checkout plumbing works.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { refreshSourcesViaControlChannel, startControlChannel } from '../src/control.ts'
import { createKernel, type Kernel } from '../src/kernel.ts'
import type { HostInventory, HostSourceRefreshReport } from '../src/types.ts'
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

/**
 * The plugin entry: the answer is BAKED INTO THE CODE, so the string the command
 * returns says which checkout is loaded (`git source v2` can only come from the
 * code of the second commit - a config value could not prove that).
 */
function pluginEntry(version: string): string {
  return `export default {
  name: 'git-demo',
  inject: ['workbench'],
  apply(ctx) {
    ctx.effect(() => ctx.workbench.registerCommand({
      name: 'git demo',
      description: 'answers from the git source',
      run: () => 'git source ${version}',
    }))
  },
}
`
}

interface Repo {
  url: string
  commits: string[]
}

/** A real repository holding one plugin under `plugins/git-demo`. */
function makeRepo(version: string, withDependencies = false): Repo {
  const dir = tempDir('workbench-refresh-repo')
  gitIn(dir, ['init', '--quiet'])
  gitIn(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  if (withDependencies) {
    fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'workbench-refresh-fixture', version: '0.0.1' }, null, 2)}\n`)
    fs.writeFileSync(path.join(dir, 'package-lock.json'), `${JSON.stringify({ name: 'workbench-refresh-fixture', lockfileVersion: 3, version }, null, 2)}\n`)
  }
  const pluginDir = path.join(dir, 'plugins', 'git-demo')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'workbench.plugin.json'), JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n')
  fs.writeFileSync(path.join(pluginDir, 'index.js'), pluginEntry(version))
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '--quiet', '-m', `plugin ${version}`])
  return { url: dir, commits: [gitIn(dir, ['rev-parse', 'HEAD'])] }
}

/** A new commit on `main`, returning its sha. */
function commitMessage(repo: Repo, version: string): string {
  fs.writeFileSync(path.join(repo.url, 'plugins', 'git-demo', 'index.js'), pluginEntry(version))
  gitIn(repo.url, ['add', '-A'])
  gitIn(repo.url, ['commit', '--quiet', '-m', `plugin ${version}`])
  const sha = gitIn(repo.url, ['rev-parse', 'HEAD'])
  repo.commits.push(sha)
  return sha
}

/** The config file: the `core` path fixture source, one git source, one roster row. */
function writeConfig(dir: string, url: string, ref: string): string {
  const file = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(
    file,
    [
      'sources:',
      '  - kind: path',
      '    id: core',
      `    path: ${JSON.stringify(FIXTURE_PLUGINS)}`,
      '    external: false',
      '  - kind: git',
      '    id: demo',
      `    url: ${JSON.stringify(url)}`,
      `    ref: ${ref}`,
      '    subdir: plugins',
      '',
      'plugins:',
      '  git-demo: {}',
      '',
    ].join('\n'),
  )
  return file
}

/** Switches the `ref` of the `demo` source IN THE CONFIG FILE (the config is truth). */
function rewriteRef(file: string, ref: string): void {
  const text = fs.readFileSync(file, 'utf8')
  fs.writeFileSync(file, text.replace(/    ref: .*\n/, `    ref: ${ref}\n`))
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/** The answer of the command the plugin registered (undefined while unloaded). */
async function answer(kernel: Kernel): Promise<string | undefined> {
  return (await kernel.registry.resolve(['git', 'demo'])?.command.run([])) as string | undefined
}

test('sources update: re-clones a missing checkout, follows a NEW commit on the configured ref, re-imports the plugin, and is idempotent', async () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-refresh-config')
  const cache = path.join(dir, 'cache')
  const configFile = writeConfig(dir, repo.url, 'main')
  const kernel = await createKernel({ configFile, log: quiet, cacheDir: cache })
  try {
    // The BOOT resolved the source (that path is unchanged and covered by
    // sources.test.ts): the plugin answers with the code of the first commit.
    assert.equal(await answer(kernel), 'git source v1')
    const checkout = path.join(cache, 'demo')
    assert.ok(fs.existsSync(path.join(checkout, '.git')), 'the boot cloned the source')

    // (a) A MISSING checkout (a wiped cache volume, a fresh deployment) is
    // cloned again by `update` - nothing else is touched.
    fs.rmSync(checkout, { recursive: true, force: true })
    const cloned = await kernel.host.refreshSources({ operation: 'update' })
    assert.equal(cloned.ok, true, cloned.message)
    assert.equal(cloned.action, 'sources-update')
    assert.equal(cloned.persisted, false, 'a refresh never persists anything')
    assert.equal(cloned.message.includes('no config write, no restart'), true, cloned.message)
    const cloneEntry = cloned.sources[0]
    assert.equal(cloneEntry.id, 'demo')
    assert.equal(cloneEntry.kind, 'git')
    assert.equal(cloneEntry.url, repo.url)
    assert.equal(cloneEntry.ref, 'main')
    assert.equal(cloneEntry.previousCommit, null, 'there was no checkout to read a commit from')
    assert.equal(cloneEntry.resolvedCommit, repo.commits[0])
    assert.deepEqual(cloneEntry.plugins, ['git-demo'])
    assert.equal(fs.existsSync(path.join(checkout, '.git')), true, 'the refresh cloned it again')

    // (b) A NEW COMMIT on the configured branch ref, with NO config change: the
    // next `update` moves the checkout and the RUNNING plugin answers NEW code.
    const second = commitMessage(repo, 'v2')
    const beforeSha = sha256(configFile)
    const updated = await kernel.host.refreshSources({ operation: 'update' })
    assert.equal(updated.ok, true, updated.message)
    assert.equal(sha256(configFile), beforeSha, 'the config file is byte-identical after the refresh')
    const updatedEntry = updated.sources[0]
    assert.equal(updatedEntry.previousCommit, repo.commits[0])
    assert.equal(updatedEntry.resolvedCommit, second)
    assert.equal(updatedEntry.changed, true)
    assert.deepEqual(updated.changed, ['demo'])
    assert.equal(updatedEntry.dir, path.join(cache, 'demo', 'plugins'))
    assert.equal(fs.readFileSync(path.join(checkout, 'plugins', 'git-demo', 'index.js'), 'utf8').includes('v2'), true)
    assert.deepEqual(updated.reimported, ['git-demo'], 'the plugin loaded from the moved source is re-imported')
    assert.deepEqual(updatedEntry.reimported, ['git-demo'])
    assert.equal(await answer(kernel), 'git source v2', 'the NEW code answers, with no restart')

    // (d) NOTHING NEW: the second call in a row reports `unchanged`, re-imports
    // nothing and keeps the SAME command function object (no fiber replaced).
    const command = kernel.registry.commands().find((entry) => entry.name === 'git demo')
    assert.ok(command, 'the command is registered')
    const again = await kernel.host.refreshSources({ operation: 'update' })
    assert.equal(again.ok, true, again.message)
    const againEntry = again.sources[0]
    assert.equal(againEntry.previousCommit, second)
    assert.equal(againEntry.resolvedCommit, second)
    assert.equal(againEntry.changed, false)
    assert.deepEqual(again.changed, [])
    assert.deepEqual(again.reimported, [])
    assert.equal(
      kernel.registry.commands().find((entry) => entry.name === 'git demo')?.run,
      command?.run,
      'an unchanged source replaces no fiber: the command function is the same object',
    )

    // `list` only READS: the remote has moved on, the checkout has not.
    const listed = await kernel.host.refreshSources({ operation: 'list' })
    assert.equal(listed.ok, true, listed.message)
    assert.equal(listed.operation, 'list')
    assert.equal(listed.sources[0].resolvedCommit, second, 'list never fetches')
    assert.equal(listed.sources[0].dependency, 'none', 'the fixture declares no package.json')

    // (c) A CONFIG `ref` CHANGE (the config is the truth; there is deliberately
    // no `--ref` override): the second ref is checked out IN PLACE.
    gitIn(repo.url, ['branch', 'stable', repo.commits[0]])
    rewriteRef(configFile, 'stable')
    const switched = await kernel.host.refreshSources({ operation: 'update' })
    assert.equal(switched.ok, true, switched.message)
    const switchedEntry = switched.sources[0]
    assert.equal(switchedEntry.ref, 'stable')
    assert.equal(switchedEntry.previousCommit, second)
    assert.equal(switchedEntry.resolvedCommit, repo.commits[0])
    assert.equal(switchedEntry.changed, true)
    assert.equal(fs.readFileSync(path.join(checkout, 'plugins', 'git-demo', 'index.js'), 'utf8').includes('v1'), true)
    assert.equal(await answer(kernel), 'git source v1', 'the code of the second ref answers in place')
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('sources update --id: refreshes ONE source, and refuses an unknown id or a path source by name', async () => {
  const repo = makeRepo('v1')
  const dir = tempDir('workbench-refresh-select')
  const cache = path.join(dir, 'cache')
  const configFile = writeConfig(dir, repo.url, 'main')
  const kernel = await createKernel({ configFile, log: quiet, cacheDir: cache })
  try {
    const one = await kernel.host.refreshSources({ operation: 'update', ids: ['demo'] })
    assert.equal(one.ok, true, one.message)
    assert.deepEqual(one.sources.map((entry) => entry.id), ['demo'])
    assert.equal(one.target, 'demo')

    const unknown = await kernel.host.refreshSources({ operation: 'update', ids: ['nope'] })
    assert.equal(unknown.ok, false)
    assert.equal(unknown.sources.length, 0)
    assert.match(unknown.message, /no configured source with id 'nope'/)

    const pathSource = await kernel.host.refreshSources({ operation: 'update', ids: ['core'] })
    assert.equal(pathSource.ok, false)
    assert.match(pathSource.message, /source 'core' is a 'path' source/)
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

test('sources update provisions the checkout dependencies through the package manager its lockfile names', async () => {
  const repo = makeRepo('v1', true)
  const dir = tempDir('workbench-refresh-deps')
  const cache = path.join(dir, 'cache')
  const configFile = writeConfig(dir, repo.url, 'main')
  // The package manager is a STUB: the test asserts the command and the outcome
  // without a network, exactly like the git side is driven through WORKBENCH_GIT.
  const calls = path.join(dir, 'npm-calls.txt')
  const stub = path.join(dir, 'npm-stub.sh')
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(calls)}\nexit 0\n`)
  fs.chmodSync(stub, 0o755)
  const previous = process.env.WORKBENCH_NPM
  process.env.WORKBENCH_NPM = stub
  const kernel = await createKernel({ configFile, log: quiet, cacheDir: cache })
  try {
    // Force a REAL install in the refresh: the dependency marker is gone.
    const marker = path.join(cache, 'demo.deps.json')
    assert.ok(fs.existsSync(marker), 'the boot provisioned the checkout')
    fs.rmSync(marker, { force: true })

    const report = await kernel.host.refreshSources({ operation: 'update' })
    assert.equal(report.ok, true, report.message)
    const dependency = report.sources[0].dependencies
    assert.ok(dependency, 'the refresh reports the dependency outcome of the checkout')
    assert.equal(dependency?.manager, 'npm')
    assert.equal(dependency?.command, 'npm ci --omit=dev')
    assert.equal(dependency?.status, 'provisioned')
    assert.equal(dependency?.dir, path.join(cache, 'demo'))
    assert.match(fs.readFileSync(calls, 'utf8').trim(), /ci --omit=dev/)
  } finally {
    if (previous === undefined) delete process.env.WORKBENCH_NPM
    else process.env.WORKBENCH_NPM = previous
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
    fs.rmSync(repo.url, { recursive: true, force: true })
  }
})

/** A minimal inventory for the channel test (no kernel needed). */
function fakeInventory(): HostInventory {
  return {
    configFile: '/tmp/workbench.config.yml',
    plugins: [],
    sources: [],
    failures: [],
    disabled: [],
    available: [],
    discovered: [],
    mutationSurface: { loaded: false, listener: null, providers: [], candidates: [], controlSocket: '/tmp/x.sock', remedy: 'none' },
    commands: [],
  }
}

function fakeRefresh(): HostSourceRefreshReport {
  return {
    ok: true,
    action: 'sources-update',
    target: '(all git sources)',
    request: { operation: 'list' },
    persisted: false,
    before: fakeInventory(),
    after: fakeInventory(),
    message: 'listed 0 source(s)',
    operation: 'list',
    sources: [],
    changed: [],
    errors: [],
    reimported: [],
  }
}

test('control channel: the sources-update op answers with the refresh report, and refuses it when the process does not expose it', async () => {
  const dir = tempDir('workbench-refresh-control')
  const socketPath = path.join(dir, 'control.sock')
  const seen: unknown[] = []
  const channel = await startControlChannel({
    socketPath,
    configFile: '/tmp/workbench.config.yml',
    inventory: fakeInventory,
    reconcile: async () => {
      throw new Error('reconcile must not be called by a sources-update')
    },
    refreshSources: async (options) => {
      seen.push(options)
      return fakeRefresh()
    },
    log: quiet,
  })
  try {
    assert.ok(channel, 'the channel is served')
    const answer = await refreshSourcesViaControlChannel(socketPath, { list: true, ids: ['demo'] })
    assert.equal(answer?.ok, true)
    assert.equal(answer?.op, 'sources-update')
    assert.deepEqual(seen, [{ operation: 'list', ids: ['demo'] }])
    assert.equal(answer?.refresh?.operation, 'list')
    assert.equal(answer?.plugins, 0)
  } finally {
    await channel?.close()
  }

  // A process that does not expose the operation refuses it BY NAME (never a
  // silent success).
  const barePath = path.join(dir, 'bare.sock')
  const bare = await startControlChannel({
    socketPath: barePath,
    configFile: '/tmp/workbench.config.yml',
    inventory: fakeInventory,
    reconcile: async () => {
      throw new Error('not used')
    },
    log: quiet,
  })
  try {
    const refused = await refreshSourcesViaControlChannel(barePath)
    assert.equal(refused?.ok, false)
    assert.match(refused?.error ?? '', /does not expose the sources-update operation/)
  } finally {
    await bare?.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Regression tests of the loader's MODULE GRAPH IDENTITY (`src/module-graph.ts`).
//
// The defect under test (production omni-stack, 2026-09-20): the module identity
// used to be put on the plugin ENTRY file ONLY. A query string does not take part
// in module RESOLUTION, so a plugin's relative helper imports kept plain
// `file://` URLs and were served from the ESM cache for the life of the process.
// A live source swap (v0.0.7 -> v0.0.8 under the running process) therefore
// imported the NEW entry while the SHARED helper stayed stale, and the load died
// with `does not provide an export named 'CHALLENGE_ACTIONS'`.
//
// These tests pin the two halves of the fix:
//   1. an UNCHANGED graph keeps the same URLs (no cache churn, reload semantics
//      of an unchanged plugin are untouched),
//   2. a CHANGED file - or a checkout swapped under a running kernel - makes the
//      WHOLE graph (entry AND helper) fresh, with no restart.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createKernel } from '../src/kernel.ts'
import { driftedSourceGraphs, moduleUrl, registerSourceGraph } from '../src/module-graph.ts'
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

/** A plugin whose command answers with the value its HELPER module exports. */
function pluginEntry(name: string, command: string): string {
  return `import { CHALLENGE_VALUE } from './helper.js'

// Re-exported so a test can observe WHICH version of the helper the entry was
// linked against: the production failure was exactly a helper whose exports did
// not match what the entry imports (link error), and a stale helper here shows
// up as a stale re-exported value.
export { CHALLENGE_VALUE } from './helper.js'

export const name = '${name}'

export function apply(ctx) {
  ctx.effect(() => ctx.workbench.registerCommand({
    name: '${command}',
    description: 'reports the helper value',
    run: () => CHALLENGE_VALUE,
  }))
}

export default { name, inject: ['workbench'], apply }
`
}

function pluginManifest(name: string, command: string): string {
  return `${JSON.stringify(
    {
      name,
      version: '0.1.0',
      description: 'test plugin importing a relative helper module',
      entry: 'index.js',
      capabilities: [`command:${command}`],
    },
    null,
    2,
  )}\n`
}

function writePlugin(dir: string, name: string, command: string, value: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbench.plugin.json'), pluginManifest(name, command))
  fs.writeFileSync(path.join(dir, 'index.js'), pluginEntry(name, command))
  fs.writeFileSync(path.join(dir, 'helper.js'), `export const CHALLENGE_VALUE = '${value}'\n`)
}

test('a changed HELPER makes the whole graph fresh, while an unchanged one keeps its URL', async () => {
  const root = tempDir('workbench-graph-unit')
  const pluginDir = path.join(root, 'plugins', 'graph-demo')
  try {
    writePlugin(pluginDir, 'graph-demo', 'graph demo', 'v1')
    const entry = path.join(pluginDir, 'index.js')

    // PRE-FIX BEHAVIOUR, reproduced deliberately: a plain file URL (or one whose
    // identity is on the ENTRY only) is cached for the life of the process, so
    // the helper value seen by the entry is frozen.
    const plain = await import(pathToFileURL(entry).href)
    assert.equal(plain.CHALLENGE_VALUE, 'v1')
    const entryOnly = await import(`${pathToFileURL(entry).href}?wb=entry-only`)
    assert.equal(entryOnly.CHALLENGE_VALUE, 'v1')

    // The loader registers the source graph, so the entry and every helper it
    // imports share ONE identity.
    registerSourceGraph(root)
    const first = moduleUrl(entry)
    const loaded = await import(first)
    assert.equal(loaded.CHALLENGE_VALUE, 'v1')
    // An UNCHANGED graph keeps its URL: re-loading is served from the cache, and
    // the reload contract of an unchanged plugin is exactly what it was.
    assert.equal(moduleUrl(entry), first, 'an unchanged source must keep the same module URL')

    // The helper changes ON DISK: the identity of the graph moves, so the entry
    // is imported anew AND its relative helper is read again.
    fs.writeFileSync(path.join(pluginDir, 'helper.js'), "export const CHALLENGE_VALUE = 'v2'\n")
    const second = moduleUrl(entry)
    assert.notEqual(second, first, 'a changed file must move the module identity')
    const reloaded = await import(second)
    assert.equal(reloaded.CHALLENGE_VALUE, 'v2', 'the helper must be re-read with the entry')

    // The OLD URL can no longer serve the OLD code: the resolve hook repoints an
    // entry (and every helper it imports) at the identity of the graph ON DISK, so
    // a stale module is UNREACHABLE rather than merely unlikely - importing the URL
    // captured before the edit observes the NEW helper as well.
    assert.equal((await import(first)).CHALLENGE_VALUE, 'v2', 'a stale entry URL is repointed at the live graph')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a checkout swapped under a RUNNING kernel is re-imported by reconcile (no restart)', async () => {
  const dir = tempDir('workbench-graph-e2e')
  const cache = path.join(dir, 'cache')
  const repo = path.join(dir, 'repo')
  try {
    // A real repository holding the plugin (the core must not depend on any
    // plugin checkout, and a mock would not prove the git plumbing works).
    fs.mkdirSync(path.join(repo, 'plugins'), { recursive: true })
    writePlugin(path.join(repo, 'plugins', 'graph-demo'), 'graph-demo', 'graph demo', 'v1')
    gitIn(repo, ['init', '--quiet', '--initial-branch=main'])
    gitIn(repo, ['add', '-A'])
    gitIn(repo, ['commit', '--quiet', '-m', 'plugin v1'])

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
        '    id: graph-source',
        `    url: ${JSON.stringify(repo)}`,
        '    ref: main',
        '    subdir: plugins',
        '',
        'plugins:',
        '  graph-demo: {}',
        '',
      ].join('\n'),
    )

    const kernel = await createKernel({ configFile, log: quiet, cacheDir: cache })
    try {
      const command = kernel.registry.resolve(['graph', 'demo'])
      assert.ok(command, 'the plugin from the git source is loaded')
      assert.equal(await command?.command.run([]), 'v1')

      // The LIVE SWAP: a new commit lands in the repository while the process
      // runs, and the reconcile re-resolves the source (in-place fetch +
      // `checkout --force --detach`), exactly what the operator did in production.
      fs.writeFileSync(path.join(repo, 'plugins', 'graph-demo', 'helper.js'), "export const CHALLENGE_VALUE = 'v2'\n")
      gitIn(repo, ['add', '-A'])
      gitIn(repo, ['commit', '--quiet', '-m', 'helper v2'])
      const swapped = gitIn(repo, ['rev-parse', 'HEAD'])

      const checkout = path.join(cache, 'graph-source')
      assert.equal(gitIn(checkout, ['rev-parse', 'HEAD']) !== swapped, true, 'the checkout still holds the OLD commit before the reconcile')

      const report = await kernel.host.reconcile()
      assert.equal(gitIn(checkout, ['rev-parse', 'HEAD']), swapped, 'the reconcile moved the checkout to the new commit')
      assert.equal(
        report.changes.some((change) => change.action === 'reload'),
        true,
        `the swapped source must re-import its plugins (report: ${JSON.stringify(report.changes)})`,
      )
      const reloaded = kernel.registry.resolve(['graph', 'demo'])
      assert.equal(await reloaded?.command.run([]), 'v2', 'the NEW helper value must be observed without a restart')
    } finally {
      await kernel.dispose()
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('driftedSourceGraphs reports a source whose code changed since its last import', async () => {
  const root = tempDir('workbench-graph-drift')
  const pluginDir = path.join(root, 'plugins', 'graph-demo')
  try {
    writePlugin(pluginDir, 'graph-demo', 'graph demo', 'v1')
    registerSourceGraph(root)
    assert.equal(driftedSourceGraphs().size, 0, 'a graph that was never imported is not a drift')
    const url = moduleUrl(path.join(pluginDir, 'index.js'))
    assert.ok(url.includes('wb='))
    assert.equal(driftedSourceGraphs().size, 0, 'an untouched graph is not a drift')
    fs.writeFileSync(path.join(pluginDir, 'helper.js'), "export const CHALLENGE_VALUE = 'v2'\n")
    assert.deepEqual([...driftedSourceGraphs()], [root], 'the changed graph is reported as drifted')
    assert.equal(driftedSourceGraphs().size, 1, 'the drift stays until the graph is re-imported')
    await import(moduleUrl(path.join(pluginDir, 'index.js')))
    assert.equal(driftedSourceGraphs().size, 0, 'importing the new graph clears the drift')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

// Regression tests of DEPENDENCY PROVISIONING for git plugin sources.
//
// The defect under test (production omni-stack, 2026-09-20): a git source was
// checked out and SCANNED, but its dependencies were never provisioned, so the
// `browser-use-playwright` provider answered the typed `provider-unavailable`
// with "the 'playwright-core' module is not installed in this deployment: run
// 'npm ci' in the workbench-plugins source" until an operator ran the install BY
// HAND inside the container.
//
// These tests pin the contract source resolution now guarantees:
//   * a fresh checkout that declares a `package.json` gets its dependencies
//     installed through the package manager its LOCKFILE names,
//   * the install is IDEMPOTENT: unchanged inputs install nothing on the next
//     resolve (offline-safe after the first successful run), a moved lockfile
//     installs again,
//   * a FAILING install is reported as a typed diagnostic that names the exact
//     command and directory - never a silent `provider-unavailable` later,
//   * `WORKBENCH_SOURCE_INSTALL=off` is the explicit opt-out and says so.
//
// The package manager is a STUB script (`WORKBENCH_NPM`): the test asserts the
// command and the outcome without a network, exactly like the git side is driven
// through `WORKBENCH_GIT`.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { resolveSource } from '../src/sources.ts'
import type { SourceSpec } from '../src/types.ts'

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

/**
 * A repository that looks like a plugin source WITH dependencies: a
 * `package.json`, a lockfile, and one plugin. `version` is written into the
 * lockfile, so a test can move it.
 */
function makeRepo(version = '1'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-deps-repo-'))
  fs.writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify({ name: 'workbench-deps-fixture', version: '0.0.1', dependencies: { 'fake-dep': '^1.0.0' } }, null, 2)}\n`,
  )
  fs.writeFileSync(path.join(dir, 'package-lock.json'), `${JSON.stringify({ name: 'workbench-deps-fixture', lockfileVersion: 3, version }, null, 2)}\n`)
  const plugin = path.join(dir, 'plugins', 'dep-demo')
  fs.mkdirSync(plugin, { recursive: true })
  fs.writeFileSync(
    path.join(plugin, 'workbench.plugin.json'),
    `${JSON.stringify({ name: 'dep-demo', version: '0.1.0', description: 'fixture plugin', entry: 'index.js', capabilities: ['command:dep demo'] }, null, 2)}\n`,
  )
  fs.writeFileSync(path.join(plugin, 'index.js'), 'export default { name: "dep-demo", apply() {} }\n')
  gitIn(dir, ['init', '--quiet', '--initial-branch=main'])
  gitIn(dir, ['add', '-A'])
  gitIn(dir, ['commit', '--quiet', '-m', `deps ${version}`])
  return dir
}

/** A stub package manager: records its invocation and creates `node_modules`. */
function writeInstaller(dir: string, options: { fail?: boolean } = {}): string {
  const file = path.join(dir, 'fake-npm.sh')
  const log = path.join(dir, 'install.log')
  fs.writeFileSync(
    file,
    [
      '#!/bin/sh',
      `echo "$PWD|$@" >> ${JSON.stringify(log)}`,
      ...(options.fail === true ? ['echo "stub failure: registry unreachable" 1>&2', 'exit 1'] : ['mkdir -p node_modules/fake-dep', 'echo "module.exports = {}" > node_modules/fake-dep/index.js', 'exit 0']),
      '',
    ].join('\n'),
  )
  fs.chmodSync(file, 0o755)
  return file
}

function installLog(dir: string): string[] {
  const file = path.join(dir, 'install.log')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
}

function gitSource(url: string, id: string): SourceSpec {
  return { kind: 'git', id, url, ref: 'main', subdir: 'plugins' }
}

/** Runs `fn` with `WORKBENCH_NPM` (and optional more env) set, restoring after. */
function withEnv(values: Record<string, string>, fn: () => void): void {
  const before: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(values)) {
    before[key] = process.env[key]
    process.env[key] = value
  }
  try {
    fn()
  } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('a fresh checkout gets its dependencies provisioned once, then cached', () => {
  const work = tempDir('workbench-deps-fresh')
  const repo = makeRepo()
  const cache = path.join(work, 'cache')
  const npm = writeInstaller(work)
  try {
    withEnv({ WORKBENCH_NPM: npm }, () => {
      const first = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      assert.equal(first.error, undefined)
      assert.equal(first.dir, path.join(cache, 'deps-source', 'plugins'))
      assert.equal(first.dependencies?.status, 'provisioned', JSON.stringify(first.dependencies))
      assert.equal(first.dependencies?.manager, 'npm')
      assert.equal(first.dependencies?.command, 'npm ci --omit=dev')
      assert.equal(first.dependencies?.dir, path.join(cache, 'deps-source'))
      assert.ok(fs.existsSync(path.join(cache, 'deps-source', 'node_modules', 'fake-dep', 'index.js')), 'the dependencies are installed in the checkout root')
      assert.deepEqual(installLog(work), [`${path.join(cache, 'deps-source')}|ci --omit=dev`], 'the lockfile selects `npm ci --omit=dev`, run in the checkout root')
      // The marker lives NEXT TO the checkout, so a `checkout --force` cannot
      // delete it and no plugin scan can see it.
      assert.ok(fs.existsSync(path.join(cache, 'deps-source.deps.json')))

      // Second resolve, unchanged inputs: NOTHING is installed (offline-safe).
      const second = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      assert.equal(second.dependencies?.status, 'cached', JSON.stringify(second.dependencies))
      assert.equal(installLog(work).length, 1, 'an unchanged checkout must not install again')
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('a changed lockfile provisions again; a missing node_modules does too', () => {
  const work = tempDir('workbench-deps-changed')
  const repo = makeRepo()
  const cache = path.join(work, 'cache')
  const npm = writeInstaller(work)
  try {
    withEnv({ WORKBENCH_NPM: npm }, () => {
      resolveSource(gitSource(repo, 'deps-source'), work, cache)
      fs.writeFileSync(path.join(repo, 'package-lock.json'), `${JSON.stringify({ name: 'workbench-deps-fixture', lockfileVersion: 3, version: '2' }, null, 2)}\n`)
      gitIn(repo, ['add', '-A'])
      gitIn(repo, ['commit', '--quiet', '-m', 'lockfile moved'])
      const moved = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      assert.equal(moved.dependencies?.status, 'provisioned', JSON.stringify(moved.dependencies))
      assert.equal(installLog(work).length, 2, 'a moved lockfile must install again')

      // A wiped node_modules is re-provisioned even when the lockfile is the same.
      fs.rmSync(path.join(cache, 'deps-source', 'node_modules'), { recursive: true, force: true })
      const wiped = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      assert.equal(wiped.dependencies?.status, 'provisioned', JSON.stringify(wiped.dependencies))
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('a FAILING install is a typed diagnostic naming the exact command, and the source still resolves', () => {
  const work = tempDir('workbench-deps-failed')
  const repo = makeRepo()
  const cache = path.join(work, 'cache')
  const npm = writeInstaller(work, { fail: true })
  try {
    withEnv({ WORKBENCH_NPM: npm }, () => {
      const resolved = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      // The code is there and reachable: the failure is about the dependencies,
      // and it is the TYPED diagnostic that says so (never silent).
      assert.equal(resolved.error, undefined)
      assert.equal(resolved.dependencies?.status, 'failed')
      assert.match(resolved.dependencies?.error ?? '', /source 'deps-source' \(git .* @ main\)/)
      assert.match(resolved.dependencies?.error ?? '', /source-dependencies-unavailable/)
      assert.match(resolved.dependencies?.error ?? '', /'npm ci --omit=dev' failed in /)
      assert.match(resolved.dependencies?.error ?? '', /registry unreachable/)
      assert.match(resolved.dependencies?.error ?? '', /run 'npm ci --omit=dev' in .* by hand/)
      assert.equal(fs.existsSync(path.join(cache, 'deps-source.deps.json')), false, 'a failed install must not mark the checkout as provisioned')
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('WORKBENCH_SOURCE_INSTALL=off is an explicit, reported opt-out', () => {
  const work = tempDir('workbench-deps-off')
  const repo = makeRepo()
  const cache = path.join(work, 'cache')
  const npm = writeInstaller(work)
  try {
    withEnv({ WORKBENCH_NPM: npm, WORKBENCH_SOURCE_INSTALL: 'off' }, () => {
      const resolved = resolveSource(gitSource(repo, 'deps-source'), work, cache)
      assert.equal(resolved.dependencies?.status, 'skipped')
      assert.match(resolved.dependencies?.error ?? '', /source-dependencies-skipped/)
      assert.match(resolved.dependencies?.error ?? '', /WORKBENCH_SOURCE_INSTALL=off/)
      assert.equal(installLog(work).length, 0, 'the opt-out really runs nothing')
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test('a source without a package.json declares no dependency work at all', () => {
  const work = tempDir('workbench-deps-none')
  const repo = tempDir('workbench-deps-plain-repo')
  const cache = path.join(work, 'cache')
  const npm = writeInstaller(work)
  try {
    const plugin = path.join(repo, 'plugins', 'plain-demo')
    fs.mkdirSync(plugin, { recursive: true })
    fs.writeFileSync(
      path.join(plugin, 'workbench.plugin.json'),
      `${JSON.stringify({ name: 'plain-demo', version: '0.1.0', description: 'fixture', entry: 'index.js', capabilities: ['command:plain demo'] }, null, 2)}\n`,
    )
    fs.writeFileSync(path.join(plugin, 'index.js'), 'export default { name: "plain-demo", apply() {} }\n')
    gitIn(repo, ['init', '--quiet', '--initial-branch=main'])
    gitIn(repo, ['add', '-A'])
    gitIn(repo, ['commit', '--quiet', '-m', 'plain'])
    withEnv({ WORKBENCH_NPM: npm }, () => {
      const resolved = resolveSource(gitSource(repo, 'plain-source'), work, cache)
      assert.equal(resolved.dependencies, undefined)
      assert.equal(installLog(work).length, 0)
      assert.equal(fs.existsSync(path.join(cache, 'plain-source.deps.json')), false)
    })
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

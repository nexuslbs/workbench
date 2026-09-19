// `host.reconcile()`: the DESIRED-vs-LIVE diff.
//
// A config file edit must reach a RUNNING process in ONE operation: the file is
// the desired state, the live cordis tree is the current state, and only the
// DELTA is applied (load / unload / reload / park). These tests drive that
// through the REAL kernel boot (the host adopts the boot state) and a REAL
// config file the test rewrites between calls - no restart anywhere.
//
// Covered: converge-from-cold, delta add, delta remove, config-change reload,
// `disabled: true` park, idempotent second call, `${cred:}` deferral, and one
// plugin that fails while the others still converge.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'
import { FIXTURE_PLUGINS, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

/** Writes the fixture config with the given `plugins:` block (the roster). */
function writeConfig(fixtureDir: string, file: string, roster: string[]): string {
  const target = path.join(fixtureDir, file)
  fs.writeFileSync(
    target,
    [
      'sources:',
      '  - kind: path',
      '    id: core',
      `    path: ${JSON.stringify(FIXTURE_PLUGINS)}`,
      '    external: false',
      '  - kind: path',
      '    id: external-plugins',
      '    path: .',
      '',
      'plugins:',
      ...roster,
      '',
    ].join('\n'),
  )
  return target
}

/** One roster line pair for a plugin row with a `message`. */
function row(name: string, message: string): string[] {
  return [`  ${name}:`, `    message: ${JSON.stringify(message)}`]
}

/** A plugin that FAILS to apply, written into the external (temp) source. */
function writeBrokenPlugin(fixtureDir: string): void {
  const dir = path.join(fixtureDir, 'broken-plugin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'broken-plugin',
        version: '0.1.0',
        description: 'test fixture: its apply() throws',
        entry: 'index.js',
        capabilities: ['command:broken thing'],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(dir, 'index.js'),
    `export const name = 'broken-plugin'\n\nexport function apply() {\n  throw new Error('this plugin refuses to apply')\n}\n\nexport default { name, inject: ['workbench'], apply }\n`,
  )
}

test('reconcile converges from COLD: nothing loaded -> every desired row is loaded, then an unchanged second call is a no-op', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'reconcile-cold.yml', [])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), [], 'the cold boot loads no plugin')

    // The caller EDITS THE FILE (the desired state) - no restart.
    writeConfig(fixture.dir, 'reconcile-cold.yml', [...row('hello-world', 'Hello World'), ...row('hello-otherworld', 'Hello Otherworld')])

    const report = await kernel.host.reconcile()
    assert.equal(report.ok, true, report.message)
    assert.equal(report.action, 'reconcile')
    assert.equal(report.persisted, false, 'reconcile never persists: the file is its INPUT')
    assert.deepEqual(report.errors, [])
    assert.deepEqual(report.deferred, [])
    assert.deepEqual(
      report.changes.map((change) => [change.name, change.action]).sort(),
      [
        ['hello-otherworld', 'load'],
        ['hello-world', 'load'],
      ],
    )
    // The LIVE tree really changed: both commands answer now.
    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])
    assert.deepEqual(report.after.available, [])

    // IDEMPOTENT: the same file again changes nothing and replaces no fiber.
    const again = await kernel.host.reconcile()
    assert.equal(again.ok, true, again.message)
    assert.deepEqual(again.changes.map((change) => change.action).sort(), ['unchanged', 'unchanged'])
    assert.deepEqual(again.deferred, [])
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('reconcile applies the DELTA: a removed row unloads the plugin, the others stay untouched', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'reconcile-remove.yml', [...row('hello-world', 'Hello World'), ...row('hello-otherworld', 'Hello Otherworld')])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])

    writeConfig(fixture.dir, 'reconcile-remove.yml', row('hello-world', 'Hello World'))
    const report = await kernel.host.reconcile()
    assert.equal(report.ok, true, report.message)
    const removed = report.changes.find((change) => change.name === 'hello-otherworld')
    assert.equal(removed?.action, 'unload')
    assert.equal(removed?.desired, false, 'the report says the row is no longer desired')
    assert.equal(removed?.loaded, true, 'and that it was loaded BEFORE the unload')
    // Its route/command is gone; the untouched plugin still answers.
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)
    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
    assert.deepEqual(report.after.available, ['hello-otherworld'])
    assert.equal(kernel.host.inventory().discovered.find((entry) => entry.name === 'hello-otherworld')?.state, 'available')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('reconcile RELOADS a plugin whose effective config changed (the new value is live, the fiber was replaced)', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'reconcile-config.yml', row('hello-otherworld', 'First value'))
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'First value')

    writeConfig(fixture.dir, 'reconcile-config.yml', row('hello-otherworld', 'Second value'))
    const report = await kernel.host.reconcile()
    assert.equal(report.ok, true, report.message)
    const change = report.changes.find((entry) => entry.name === 'hello-otherworld')
    assert.equal(change?.action, 'reload')
    assert.equal(change?.loaded, true)
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Second value')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('reconcile PARKS a row marked disabled: true (unloaded, still on the roster, never a failure)', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'reconcile-park.yml', [...row('hello-world', 'Hello World'), ...row('hello-otherworld', 'Hello Otherworld')])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    writeConfig(fixture.dir, 'reconcile-park.yml', ['  hello-world:', '    message: "Hello World"', '  hello-otherworld:', '    disabled: true'])
    const report = await kernel.host.reconcile()
    assert.equal(report.ok, true, report.message)
    const parked = report.changes.find((change) => change.name === 'hello-otherworld')
    assert.equal(parked?.action, 'unload')
    assert.match(parked?.reason ?? '', /parked/)
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined, 'a parked plugin is not loaded')
    assert.deepEqual(kernel.failures, [], 'a parked row is never a failure')
    assert.deepEqual(report.after.disabled, ['hello-otherworld'])
    assert.deepEqual(report.after.available, [])
    assert.equal(kernel.host.inventory().discovered.find((entry) => entry.name === 'hello-otherworld')?.state, 'disabled')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('reconcile DEFERS a row that needs a credential while no credentials provider is loaded (structured, no crash)', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'reconcile-defer.yml', row('hello-world', 'Hello World'))
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    // The row now references a credential; the core ships NO provider (it lives
    // in the external plugins repo), so the SAME boot gate applies live.
    writeConfig(fixture.dir, 'reconcile-defer.yml', [
      ...row('hello-world', 'Hello World'),
      '  hello-otherworld:',
      '    message: "Hello Otherworld"',
      '    token: "${cred:EXTERNAL_DEMO_TOKEN}"',
    ])
    const report = await kernel.host.reconcile()
    assert.equal(report.ok, true, 'a deferral is NOT an error')
    assert.deepEqual(report.deferred, ['hello-otherworld'])
    assert.deepEqual(report.errors, [])
    const change = report.changes.find((entry) => entry.name === 'hello-otherworld')
    assert.equal(change?.action, 'deferred')
    assert.match(change?.reason ?? '', /credential/)
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined, 'a deferred row is never loaded with an unresolved reference')
    // The rest of the roster is unaffected and the process keeps serving.
    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('reconcile survives a FAILING plugin: that row is an error, the others still converge', async () => {
  const fixture = externalFixture()
  writeBrokenPlugin(fixture.dir)
  const configFile = writeConfig(fixture.dir, 'reconcile-fail.yml', row('hello-world', 'Hello World'))
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    writeConfig(fixture.dir, 'reconcile-fail.yml', [
      ...row('hello-world', 'Hello World'),
      ...row('hello-otherworld', 'Hello Otherworld'),
      '  broken-plugin: {}',
    ])
    const report = await kernel.host.reconcile()
    assert.equal(report.ok, false, 'the report must NOT claim a full convergence')
    assert.deepEqual(report.errors, ['broken-plugin'])
    const broken = report.changes.find((change) => change.name === 'broken-plugin')
    assert.equal(broken?.action, 'error')
    assert.match(broken?.error ?? '', /refuses to apply/)
    // The other two rows converged anyway - one bad row never aborts the roster.
    // (`hello-world` already agreed with the file, so it is `unchanged`, not `load`.)
    assert.deepEqual(
      report.changes
        .filter((change) => change.action === 'load')
        .map((change) => change.name)
        .sort(),
      ['hello-otherworld'],
    )
    assert.deepEqual(
      report.changes.filter((change) => change.action === 'unchanged').map((change) => change.name),
      ['hello-world'],
    )
    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    assert.equal(kernel.host.inventory().discovered.find((entry) => entry.name === 'broken-plugin')?.state, 'failed')

    // A second call re-tries the failing row (still an error) WITHOUT touching
    // the two converged plugins.
    const again = await kernel.host.reconcile()
    assert.equal(again.ok, false)
    assert.deepEqual(again.errors, ['broken-plugin'])
    assert.equal(again.changes.filter((change) => change.action === 'unchanged').length, 2)
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

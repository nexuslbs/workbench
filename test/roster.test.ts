// ROSTER semantics (breaking change, v0.0.2):
//
//   `sources:`  = where plugins are DISCOVERED (what is AVAILABLE)
//   `plugins:`  = the ROSTER: the plugins that are LOADED, plus their config
//
// A discovered plugin WITHOUT a `plugins.<name>` row is AVAILABLE: listed by the
// inventory, loadable with one `enable`, never imported. `disabled: true` parses
// the row (it stays on the roster, deliberately off) and is reported under
// `disabled`, never under `failures`.
//
// Every test here FAILS on the old scan-and-load semantics, where a discovered
// plugin was imported whether or not the config named it.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'
import { readConfig } from '../src/config.ts'
import { FIXTURE_PLUGINS, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

/** The fixture config, with the `plugins:` roster the caller asks for instead. */
function rosterConfig(fixtureDir: string, name: string, roster: string[]): string {
  const file = path.join(fixtureDir, name)
  fs.writeFileSync(
    file,
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
  return file
}

test('a discovered plugin with no plugins: row is AVAILABLE - listed, never imported', async () => {
  const fixture = externalFixture()
  // The roster names the core plugin only: hello-otherworld is discovered (it
  // exists in the external source) but has no row, so it must not load.
  const configFile = rosterConfig(fixture.dir, 'available.yml', ['  hello-world:', '    message: "Hello World"'])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['hello-world'])
    assert.deepEqual(kernel.failures, [], 'an unconfigured plugin is not a failure')
    // Not imported: its command does not exist.
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)

    const inventory = kernel.host.inventory()
    assert.deepEqual(inventory.available, ['hello-otherworld'])
    assert.deepEqual(inventory.disabled, [])
    const discovered = inventory.discovered.find((entry) => entry.name === 'hello-otherworld')
    assert.equal(discovered?.state, 'available')
    assert.equal(discovered?.roster, false, 'the inventory must say the plugin is NOT on the roster')
    assert.equal(discovered?.source, 'external-plugins')
    assert.ok(discovered?.dir, 'an available plugin still reports where it lives')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('a named plugin is loaded and receives its row as config', async () => {
  const fixture = externalFixture()
  const configFile = rosterConfig(fixture.dir, 'named.yml', [
    '  hello-world:',
    '    message: "Hello World"',
    '  hello-otherworld:',
    '    message: "Rostered Otherworld"',
  ])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Rostered Otherworld')
    assert.deepEqual(kernel.host.inventory().available, [])
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('disabled: true PARKS a rostered plugin: not loaded, reported under disabled, never a failure', async () => {
  const fixture = externalFixture()
  const configFile = rosterConfig(fixture.dir, 'parked.yml', [
    '  hello-world:',
    '    message: "Hello World"',
    '  hello-otherworld:',
    '    disabled: true',
  ])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['hello-world'])
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)
    assert.deepEqual(kernel.failures, [])
    const inventory = kernel.host.inventory()
    assert.deepEqual(inventory.disabled, ['hello-otherworld'])
    assert.deepEqual(inventory.available, [])
    const entry = inventory.discovered.find((plugin) => plugin.name === 'hello-otherworld')
    assert.equal(entry?.state, 'disabled')
    assert.equal(entry?.roster, true, 'a parked plugin is still on the roster')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('enable() persists the roster row and loads the plugin (survives a reboot)', async () => {
  const fixture = externalFixture()
  const configFile = rosterConfig(fixture.dir, 'enable.yml', ['  hello-world:', '    message: "Hello World"'])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(kernel.host.inventory().available, ['hello-otherworld'])

    const result = await kernel.host.enable('hello-otherworld')
    assert.equal(result.ok, true, result.message)
    assert.equal(result.persisted, true, 'enable must persist the roster row through the config seam')

    const after = kernel.host.inventory()
    assert.deepEqual(after.available, [])
    assert.ok(after.plugins.some((plugin) => plugin.name === 'hello-otherworld'))
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')

    // The row reached the FILE (persisted config edit, read back independently).
    const written = fs.readFileSync(configFile, 'utf8')
    assert.match(written, /^  hello-otherworld: \{\}$/m, 'the roster row must be persisted')
    assert.ok(Object.hasOwn(readConfig(configFile).config.plugins ?? {}, 'hello-otherworld'))
  } finally {
    await kernel.dispose()
  }

  // A fresh boot from the same file loads it: the row is what selects it.
  const reboot = await createKernel({ configFile, log: quiet })
  try {
    assert.deepEqual(reboot.plugins.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])
    assert.deepEqual(reboot.host.inventory().available, [])
  } finally {
    await reboot.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('disable() unloads, parks the loaded plugin and persists disabled: true', async () => {
  const fixture = externalFixture()
  const configFile = rosterConfig(fixture.dir, 'disable.yml', [
    '  hello-world:',
    '    message: "Hello World"',
    '  hello-otherworld:',
    '    message: "Hello Otherworld"',
  ])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    const result = await kernel.host.disable('hello-otherworld')
    assert.equal(result.ok, true, result.message)
    assert.equal(result.persisted, true)

    const inventory = kernel.host.inventory()
    assert.deepEqual(inventory.disabled, ['hello-otherworld'])
    assert.equal(inventory.plugins.some((plugin) => plugin.name === 'hello-otherworld'), false)
    assert.deepEqual(inventory.failures, [])
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)

    const written = fs.readFileSync(configFile, 'utf8')
    assert.match(written, /^  hello-otherworld:$/m, 'the row stays (parked, configured)')
    assert.match(written, /^    disabled: true$/m)
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('disabling a plugin that is only AVAILABLE invents no row and no failure', async () => {
  const fixture = externalFixture()
  const configFile = rosterConfig(fixture.dir, 'available-disable.yml', ['  hello-world:', '    message: "Hello World"'])
  const kernel = await createKernel({ configFile, log: quiet })
  try {
    const result = await kernel.host.disable('hello-otherworld')
    assert.equal(result.ok, true, result.message)
    assert.equal(result.persisted, false)
    const inventory = kernel.host.inventory()
    assert.deepEqual(inventory.available, ['hello-otherworld'])
    assert.deepEqual(inventory.disabled, [])
    assert.equal(fs.readFileSync(configFile, 'utf8').includes('hello-otherworld'), false, 'no row may be invented')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

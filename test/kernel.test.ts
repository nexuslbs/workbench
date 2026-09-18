// End-to-end tests of the load-and-run path:
//  - the core plugin (./plugins) AND the external plugin (../workbench-plugins)
//    are discovered and loaded through the same plugin-source mechanism,
//  - both registers their command and both greetings come out,
//  - the CLI (the documented smoke command) produces the same result,
//  - the external command is absent when external sources are skipped, which is
//    what makes the first test fail if the external plugin is not loaded.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createKernel } from '../src/kernel.ts'
import { expandEnvDeep } from '../src/config.ts'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = path.join(ROOT, 'workbench.config.json')
const quiet = (): void => undefined

test('loads the core plugin and the external plugin, and runs both greetings', async () => {
  const kernel = await createKernel({ configFile: CONFIG, log: quiet })
  try {
    const names = kernel.plugins.map((plugin) => plugin.name).sort()
    assert.deepEqual(names, ['hello-otherworld', 'hello-world'])

    const external = kernel.plugins.find((plugin) => plugin.name === 'hello-otherworld')
    assert.ok(external, 'hello-otherworld must be loaded from the external source workbench-plugins')
    assert.equal(external.source, 'workbench-plugins')
    assert.equal(external.external, true)

    const core = kernel.plugins.find((plugin) => plugin.name === 'hello-world')
    assert.equal(core?.external, false)

    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    assert.equal(kernel.registry.commands().find((command) => command.name === 'hello otherworld')?.plugin, 'hello-otherworld')
  } finally {
    await kernel.dispose()
  }
})

test('the external plugin disappears when external sources are skipped', async () => {
  const kernel = await createKernel({ configFile: CONFIG, includeExternal: false, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['hello-world'])
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)
  } finally {
    await kernel.dispose()
  }
})

test('CLI (documented smoke): hello otherworld comes from the external plugin', () => {
  const result = spawnSync(process.execPath, ['src/cli.ts', 'hello', 'otherworld'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout.trim(), 'Hello Otherworld')

  const listed = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /hello-otherworld@0\.1\.0\s+external:workbench-plugins/)
})

test('config values expand ${env:VAR} references', () => {
  process.env.WORKBENCH_TEST_SOURCE = './plugins'
  assert.deepEqual(expandEnvDeep({ sources: [{ kind: 'path', path: '${env:WORKBENCH_TEST_SOURCE}' }] }), {
    sources: [{ kind: 'path', path: './plugins' }],
  })
  delete process.env.WORKBENCH_TEST_SOURCE
})

// End-to-end tests of the load-and-run path:
//  - the DEFAULT config ships ZERO plugins and boots an EMPTY kernel,
//  - a local fixture source AND an external fixture source (both temp dirs) are
//    discovered and loaded through the same plugin-source mechanism,
//  - both register their command and both greetings come out,
//  - the CLI (the documented smoke command) produces the same result,
//  - the external command is absent when external sources are skipped,
//  - `serve` is a real long-running entrypoint (it answers /health and stays up).
//
// Every plugin used here is a FIXTURE created in a temp dir (see
// `test/fixtures.ts`): the core repo ships no plugin at all and depends on no
// plugins repository.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { expandEnvDeep } from '../src/config.ts'
import { createKernel } from '../src/kernel.ts'
import { DEFAULT_CONFIG, ROOT, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

test('the default config ships ZERO plugins and still boots an empty kernel', async () => {
  const kernel = await createKernel({ configFile: DEFAULT_CONFIG, log: quiet })
  try {
    assert.deepEqual(kernel.plugins, [], 'the core ships no plugin, so none can be loaded')
    assert.deepEqual(kernel.sources, [], 'the default config declares no source')
    assert.deepEqual(kernel.registry.commands(), [], 'no plugin registered a command')
    assert.equal(kernel.registry.resolve(['hello', 'world']), undefined)

    const inventory = kernel.host.inventory()
    assert.deepEqual(inventory.discovered, [])
    assert.deepEqual(inventory.available, [])
    assert.deepEqual(inventory.failures, [])

    // The plugin-less core stays BOOTABLE and reports the web state instead of
    // starting a listener: the `web@1` provider is a PLUGIN (external repo) and
    // the core ships none. `off` here (the default config asks for no web UI),
    // `deferred` when it is asked for and unserved: never a crash, never a
    // silent skip (test/web-state.test.ts covers both states end to end).
    assert.equal(kernel.webState.state, 'off', 'no web provider plugin and no web: section')
    assert.equal(kernel.webState.enabled, false)
  } finally {
    await kernel.dispose()
  }
})

test('loads the local fixture source and an external fixture plugin, and runs both greetings', async () => {
  const fixture = externalFixture()
  const kernel = await createKernel({ configFile: fixture.yml, log: quiet })
  try {
    const names = kernel.plugins.map((plugin) => plugin.name).sort()
    assert.deepEqual(names, ['hello-otherworld', 'hello-world'])

    const external = kernel.plugins.find((plugin) => plugin.name === 'hello-otherworld')
    assert.ok(external, 'hello-otherworld must be loaded from the external source external-plugins')
    assert.equal(external.source, 'external-plugins')
    assert.equal(external.external, true)
    assert.equal(external.dir, fixture.sourceDir)

    const core = kernel.plugins.find((plugin) => plugin.name === 'hello-world')
    assert.equal(core?.external, false)

    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    assert.equal(kernel.registry.commands().find((command) => command.name === 'hello otherworld')?.plugin, 'hello-otherworld')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('the external plugin disappears when external sources are skipped', async () => {
  const fixture = externalFixture()
  const kernel = await createKernel({ configFile: fixture.yml, includeExternal: false, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['hello-world'])
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('CLI (documented smoke): hello otherworld comes from the external plugin', () => {
  const fixture = externalFixture()
  try {
    const result = spawnSync(process.execPath, ['src/cli.ts', '--config', fixture.yml, 'hello', 'otherworld'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), 'Hello Otherworld')

    const listed = spawnSync(process.execPath, ['src/cli.ts', '--config', fixture.yml, 'plugins'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(listed.status, 0, listed.stderr)
    assert.match(listed.stdout, /hello-otherworld@0\.1\.0\s+external:external-plugins/)
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('CLI: the default config boots with ZERO plugins (no plugins repository required)', () => {
  const listed = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /workbench: 0 plugin\(s\) loaded \(0 core, 0 external\)/)
  assert.doesNotMatch(listed.stdout, /hello-world/, 'the core ships no plugin to list')

  const hello = spawnSync(process.execPath, ['src/cli.ts', 'hello', 'world'], { cwd: ROOT, encoding: 'utf8' })
  assert.notEqual(hello.status, 0, 'no plugin registers a command, so nothing can run it')
  assert.doesNotMatch(hello.stdout, /Hello World/)
})

test('CLI: CONFIG_FILE selects the config file, an empty value keeps the default', () => {
  const fixture = externalFixture()
  try {
    const fromEnv = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CONFIG_FILE: fixture.yml },
    })
    assert.equal(fromEnv.status, 0, fromEnv.stderr)
    assert.match(fromEnv.stdout, /hello-otherworld@0\.1\.0\s+external:external-plugins/)

    const empty = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CONFIG_FILE: '' },
    })
    assert.equal(empty.status, 0, empty.stderr)
    assert.match(empty.stdout, /workbench: 0 plugin\(s\) loaded \(0 core, 0 external\)/)

    const missing = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CONFIG_FILE: `${fixture.dir}/nope.yml` },
    })
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /cannot read config file/)
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('CLI: serve keeps running and answers its status endpoint', async () => {
  const fixture = externalFixture()
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['src/cli.ts', 'serve', '--port', String(port)], {
    cwd: ROOT,
    env: { ...process.env, CONFIG_FILE: fixture.yml },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString() })
  try {
    let status: { status?: string; configFile?: string; plugins?: { name: string }[] } | undefined
    for (let attempt = 0; attempt < 50 && !status; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`)
        status = (await response.json()) as typeof status
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    assert.ok(status, `serve never answered /health; output:\n${output}`)
    assert.equal(status.status, 'ok')
    assert.equal(status.configFile, fixture.yml)
    assert.deepEqual(status.plugins?.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])
    assert.equal(child.exitCode, null, `serve must stay up, but it exited; output:\n${output}`)
    assert.match(output, /serving on http:\/\/0\.0\.0\.0:/)
  } finally {
    child.kill('SIGTERM')
    const code = await new Promise((resolve) => child.once('exit', (value) => resolve(value)))
    assert.equal(code, 0, `serve must exit cleanly on SIGTERM; output:\n${output}`)
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('config values expand ${env:VAR} references', () => {
  process.env.WORKBENCH_TEST_SOURCE = './plugins'
  assert.deepEqual(expandEnvDeep({ sources: [{ kind: 'path', path: '${env:WORKBENCH_TEST_SOURCE}' }] }), {
    sources: [{ kind: 'path', path: './plugins' }],
  })
  delete process.env.WORKBENCH_TEST_SOURCE
})

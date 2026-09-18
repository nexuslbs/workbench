// End-to-end tests of the load-and-run path:
//  - the DEFAULT config is core-only and boots without any external source,
//  - the core plugin AND an external plugin (a temp fixture source) are
//    discovered and loaded through the same plugin-source mechanism,
//  - both register their command and both greetings come out,
//  - the CLI (the documented smoke command) produces the same result,
//  - the external command is absent when external sources are skipped,
//  - `serve` is a real long-running entrypoint (it answers /health and stays up).
//
// The external plugin is a fixture in a temp dir: the core repo has no
// dependency on the `workbench-plugins` repository.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import test from 'node:test'
import { expandEnvDeep } from '../src/config.ts'
import { createKernel } from '../src/kernel.ts'
import { DEFAULT_CONFIG, ROOT, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

test('the default config is core-only and boots without external sources', async () => {
  const kernel = await createKernel({ configFile: DEFAULT_CONFIG, log: quiet })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['hello-world'])
    assert.deepEqual(kernel.sources.map((source) => [source.id, source.external]), [['core', false]])
    assert.equal(kernel.registry.resolve(['hello', 'otherworld']), undefined)
    assert.equal(await kernel.registry.resolve(['hello', 'world'])?.command.run([]), 'Hello World')
  } finally {
    await kernel.dispose()
  }
})

test('loads the core plugin and an external fixture plugin, and runs both greetings', async () => {
  const fixture = externalFixture()
  const kernel = await createKernel({ configFile: fixture.yml, log: quiet })
  try {
    const names = kernel.plugins.map((plugin) => plugin.name).sort()
    assert.deepEqual(names, ['hello-otherworld', 'hello-world'])

    const external = kernel.plugins.find((plugin) => plugin.name === 'hello-otherworld')
    assert.ok(external, 'hello-otherworld must be loaded from the external source workbench-plugins')
    assert.equal(external.source, 'workbench-plugins')
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
    assert.match(listed.stdout, /hello-otherworld@0\.1\.0\s+external:workbench-plugins/)
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('CLI: the default config boots core-only (no plugins repository required)', () => {
  const listed = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /workbench: 1 plugin\(s\) loaded \(1 core, 0 external\)/)
  assert.match(listed.stdout, /hello-world@0\.1\.0\s+core/)

  const hello = spawnSync(process.execPath, ['src/cli.ts', 'hello', 'world'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(hello.status, 0, hello.stderr)
  assert.equal(hello.stdout.trim(), 'Hello World')
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
    assert.match(fromEnv.stdout, /hello-otherworld@0\.1\.0\s+external:workbench-plugins/)

    const empty = spawnSync(process.execPath, ['src/cli.ts', 'plugins'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, CONFIG_FILE: '' },
    })
    assert.equal(empty.status, 0, empty.stderr)
    assert.match(empty.stdout, /workbench: 1 plugin\(s\) loaded \(1 core, 0 external\)/)

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

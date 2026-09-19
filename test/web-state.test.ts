// The WEB GATE (operator rule 2026-09-19): the core ships NO web module.
//
// The `web@1` Definition AND the server providers live in the EXTERNAL plugins
// repository (`nexuslbs/workbench-plugins`: `definitions/web.ts` + the plugin
// `web-impl`). The core only knows the capability ID and reports what this
// deployment got:
//
//   off      -> nothing asked for,
//   deferred -> the config asks for the Web UI and NO provider plugin is
//               loaded: a STRUCTURED state, a loud log line, no crash and no
//               silent skip - the process keeps serving,
//   served   -> a provider plugin is loaded: the core registers its OWN routes
//               (the loader status, the inventory, the tool dispatch) on the
//               seam that plugin provided.
//
// This file pins all three states, including the CLI behaviour of the deferred
// one (the deployment healthcheck must still answer) and the fact that the core
// registers its routes on a seam it did NOT create.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ROOT } from './fixtures.ts'
import { createKernel } from '../src/kernel.ts'

/** A generated PATH source holding one plugin that PROVIDES the `web` seam. */
function webProviderFixture(options: { servesHealth?: boolean } = {}): { dir: string; source: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-provider-'))
  const source = path.join(dir, 'plugins')
  const pluginDir = path.join(source, 'web-impl-fixture')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'web-impl-fixture',
        version: '0.1.0',
        description: 'generated test fixture: provides the web@1 seam (no real listener)',
        entry: 'index.js',
        // The capability declaration the core's gate looks for; `provider` is
        // what makes it a PROVIDER and not a consumer of the seam.
        capabilities: [{ id: 'web', version: 1, provider: 'fixture' }],
      },
      null,
      2,
    ) + '\n',
  )
  // A fixture that answers `/health` ITSELF, exactly like the real `web-impl`
  // provider: the core must then NOT register a second handler for the same
  // method+path (the `web@1` seam rejects a duplicate and that aborts the boot).
  const healthRegistration = options.servesHealth
    ? "  seam.route({ method: 'GET', path: '/health', description: 'fixture health' })\n" +
      "  seam.route({ method: 'HEAD', path: '/health', description: 'fixture health' })\n"
    : ''
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `export const name = 'web-impl-fixture'

export function apply(ctx) {
  const specs = []
  // The seam a real provider plugin provides. The core must register its own
  // routes on THIS object (it creates nothing itself).
  const seam = {
    route: (spec) => {
      specs.push(spec)
      return () => {
        const index = specs.indexOf(spec)
        if (index >= 0) specs.splice(index, 1)
      }
    },
    routes: () => [...specs],
    pages: () => [],
    assets: () => [],
  }
  ctx.provide('web', seam)
${healthRegistration}
  // How the test reads the routes the CORE registered on a foreign seam.
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'seam routes',
    description: 'the routes registered on the seam (test fixture)',
    run: () => JSON.stringify(specs.map((spec) => spec.method + ' ' + spec.path)),
  }))
}

export default { name, inject: ['workbench'], apply }
`,
  )
  return { dir, source }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    // `close` (not `exit`) plus the already-exited guard: a child that died
    // before we attach the listener would otherwise hang the test forever.
    if (child.exitCode !== null || child.signalCode !== null) return resolve()
    child.once('close', () => resolve())
    child.kill('SIGTERM')
  })
}

test('the web section is DEFERRED (structured, not a crash) when no provider plugin is loaded', async () => {
  const kernel = await createKernel({
    config: { sources: [], plugins: {}, web: { enabled: true, port: 0 } },
    log: () => {},
  })
  try {
    assert.equal(kernel.webState.state, 'deferred')
    assert.equal(kernel.webState.enabled, true)
    assert.match(kernel.webState.reason ?? '', /no plugin providing web@1 is loaded/)
    assert.match(kernel.webState.reason ?? '', /workbench-plugins/, 'the reason names the source to fix it')
    // No crash and no silent skip: the kernel booted, the inventory is readable.
    assert.deepEqual(kernel.plugins, [])
    assert.deepEqual(kernel.host.inventory().failures, [])
  } finally {
    await kernel.dispose()
  }
})

test('a provider PLUGIN serves the seam and the core registers its own routes on it', async () => {
  const fixture = webProviderFixture()
  const kernel = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'web-fixture', path: fixture.source, external: false }],
      plugins: { 'web-impl-fixture': {} },
      web: { enabled: true },
    },
    configDir: fixture.dir,
    log: () => {},
  })
  try {
    assert.deepEqual(
      { state: kernel.webState.state, plugin: kernel.webState.plugin, provider: kernel.webState.provider, external: kernel.webState.external },
      { state: 'served', plugin: 'web-impl-fixture', provider: 'fixture', external: false },
      'the gate reports WHO serves the seam, and where it came from',
    )
    const found = kernel.registry.resolve(['seam', 'routes'])
    assert.ok(found, 'the fixture registered its reporting command')
    const answer = await found.command.run(found.args)
    const routes = JSON.parse(String(answer)) as string[]
    assert.ok(routes.includes('GET /health'), `the core registered its status route on the plugin seam (${routes.join(', ')})`)
    assert.ok(routes.includes('GET /api/plugins'), 'the core registered its inventory route on the plugin seam')
    assert.ok(
      routes.every((route) => !route.includes('/api/tools')),
      `the core registers NO tool route: the tools capability lives in a plugin (${routes.join(', ')})`,
    )
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('a provider that answers /health ITSELF is not double-registered by the core', async () => {
  // The real `web-impl` provider registers GET/HEAD /health (the `web@1` contract
  // plus the live inventory) during its own apply, BEFORE the core registers its
  // routes. The `web@1` seam REJECTS a duplicate method+path, so an unconditional
  // core registration aborted the whole boot (found by the CI replay: the
  // workbench container exited 1 in the deployment shape, task 2486). The core
  // must treat the provider's /health as the deployment healthcheck and fill the
  // gap only when the provider answers none.
  const fixture = webProviderFixture({ servesHealth: true })
  const kernel = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'web-fixture-health', path: fixture.source, external: false }],
      plugins: { 'web-impl-fixture': {} },
      web: { enabled: true },
    },
    configDir: fixture.dir,
    log: () => {},
  })
  try {
    assert.equal(kernel.webState.state, 'served')
    const found = kernel.registry.resolve(['seam', 'routes'])
    assert.ok(found, 'the fixture registered its reporting command')
    const routes = JSON.parse(String(await found.command.run(found.args))) as string[]
    assert.equal(
      routes.filter((route) => route === 'GET /health').length,
      1,
      `exactly ONE GET /health handler on the seam (${routes.join(', ')})`,
    )
    assert.equal(routes.filter((route) => route === 'HEAD /health').length, 1, 'exactly one HEAD /health handler')
    assert.ok(routes.includes('GET /api/plugins'), 'the core still registers the routes the provider does NOT answer')
  } finally {
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('the deferred section binds NO port: the process stays UP and reports the structured state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-deferred-'))
  const configFile = path.join(dir, 'config.yml')
  fs.writeFileSync(
    configFile,
    ['sources: []', 'plugins: {}', 'web:', '  enabled: true', '',].join('\n'),
  )
  const port = await freePort()
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), 'serve', '--config', configFile, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')))
  try {
    // The core owns NO listener: with no provider plugin NOTHING is bound (the
    // web server is always a plugin) and the deferral is reported instead.
    await new Promise((resolve) => setTimeout(resolve, 1500))
    await assert.rejects(
      fetch(`http://127.0.0.1:${port}/health`),
      'the core must not bind a port when no web@1 provider plugin is loaded',
    )
    assert.equal(child.exitCode, null, `the deferred web section keeps the process UP; output:\n${output}`)
    assert.match(output, /web is DEFERRED/, 'the operator sees the structured deferral on stdout, never a silent skip')
    assert.match(output, /0 plugin\(s\) loaded/, `and the inventory with it; output:\n${output}`)
  } finally {
    await stop(child)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

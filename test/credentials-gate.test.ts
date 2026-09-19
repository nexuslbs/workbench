// THE `${cred:...}` GATE (operator rule 2026-09-19).
//
// Config entries (SOURCES and PLUGINS) whose config needs a credential
// implicitly depend on a plugin implementing the `credentials@1` service
// definition. The core ships NO provider, so:
//
//   * with NO provider plugin loaded the entry is DEFERRED - logged, reported in
//     the source report, the process keeps serving, nothing crashes and nothing
//     is silently skipped;
//   * once a provider plugin IS loaded (from a source that needs no credential)
//     the entry becomes eligible and loads.
//
// The provider plugin used here is a TEST FIXTURE written into a temp directory:
// the core never ships one, and the plugins repository is not required for
// `npm test`.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'

const CREDENTIAL_NAME = 'DEMO'
const CREDENTIAL_VALUE = 'example-value-from-the-fixture-provider'

/** Writes a fixture credentials PROVIDER plugin (capability `credentials@1`). */
function writeProviderPlugin(dir: string): string {
  const pluginDir = path.join(dir, 'credentials-fixture')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'credentials-fixture',
        version: '0.1.0',
        description: 'test fixture: a credentials@1 provider (the core ships none)',
        entry: 'index.js',
        capabilities: [{ id: 'credentials', version: 1, provider: 'fixture' }],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `export const name = 'credentials-fixture'

export function apply(ctx, config = {}) {
  const values = config.values ?? {}
  ctx.effect(() => ctx.credentials.register({
    id: 'fixture',
    version: 1,
    describe: () => 'the test fixture provider',
    resolve: (ref) => values[ref.name],
  }))
}

export default { name, inject: ['credentials'], apply }
`,
  )
  return dir
}

/** Writes a fixture plugin whose CONFIG needs a credential. */
function writeGatedPlugin(dir: string): string {
  const pluginDir = path.join(dir, 'hello-gated')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'hello-gated',
        version: '0.1.0',
        description: 'test fixture: a command whose config is a credential reference',
        entry: 'index.js',
        capabilities: ['command:hello gated'],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `export const name = 'hello-gated'

export function apply(ctx, config = {}) {
  const message = config.message ?? '(unset)'
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'hello gated',
    description: 'prints the resolved message',
    run: () => message,
  }))
}

export default { name, inject: ['workbench'], apply }
`,
  )
  return dir
}

test('the gate defers a credential-dependent SOURCE when no provider plugin is loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gate-source-'))
  const lines: string[] = []
  const kernel = await createKernel({
    config: {
      sources: [
        {
          kind: 'git',
          id: 'private-plugins',
          url: 'https://github.invalid/nexuslbs/workbench-plugins-private',
          auth: { type: 'github-app', credential: 'GITHUB_APP_KEY', appId: 3967918, installationId: 138119822 },
        },
      ],
      plugins: {},
    },
    configDir: dir,
    cacheDir: path.join(dir, 'sources'),
    includeExternal: true,
    log: (message) => lines.push(message),
  })
  // No provider plugin -> the source is reported DEFERRED (not a failure, not a
  // silent skip), the boot completes and ZERO plugins are loaded.
  assert.deepEqual(kernel.plugins, [])
  assert.deepEqual(kernel.failures, [])
  const source = kernel.sources.find((entry) => entry.id === 'private-plugins')
  assert.ok(source !== undefined)
  assert.match(source.error ?? '', /deferred/)
  assert.match(source.error ?? '', /credentials@1/)
  assert.ok(lines.some((line) => /private-plugins' is DEFERRED/.test(line)))
  // The credential VALUE is never part of any log line.
  assert.ok(!lines.join('\n').includes(CREDENTIAL_VALUE))
})

test('the gate defers a credential-dependent PLUGIN row, then loads it once a provider plugin is loaded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-gate-plugin-'))
  const providerSource = writeProviderPlugin(path.join(dir, 'provider-source'))
  const gatedSource = writeGatedPlugin(path.join(dir, 'gated-source'))

  // (a) NO provider plugin: the roster row uses `${cred:DEMO}` -> DEFERRED.
  const deferredLines: string[] = []
  const gated = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'gated', path: gatedSource }],
      plugins: { 'hello-gated': { message: '${cred:DEMO}' } },
    },
    configDir: dir,
    cacheDir: path.join(dir, 'sources-a'),
    includeExternal: true,
    log: (message) => deferredLines.push(message),
  })
  assert.deepEqual(gated.plugins, [])
  assert.deepEqual(gated.failures, [])
  assert.deepEqual(gated.sources.filter((entry) => entry.plugins > 0), [])
  assert.ok(deferredLines.some((line) => /hello-gated' is DEFERRED/.test(line)))

  // (b) the PUBLIC-shaped provider plugin loaded from a source that needs no
  // credential: the gate opens, the row is expanded and the plugin loads.
  const liveLines: string[] = []
  const kernel = await createKernel({
    config: {
      sources: [
        { kind: 'path', id: 'provider', path: providerSource },
        { kind: 'path', id: 'gated', path: gatedSource },
      ],
      plugins: {
        'credentials-fixture': { values: { [CREDENTIAL_NAME]: CREDENTIAL_VALUE } },
        'hello-gated': { message: '${cred:DEMO}' },
      },
    },
    configDir: dir,
    cacheDir: path.join(dir, 'sources-b'),
    includeExternal: true,
    log: (message) => liveLines.push(message),
  })
  assert.deepEqual(kernel.failures, [])
  assert.deepEqual(
    kernel.plugins.map((plugin) => plugin.name).sort(),
    ['credentials-fixture', 'hello-gated'],
  )
  const resolution = await kernel.credentials.resolve({ name: CREDENTIAL_NAME })
  assert.equal(resolution?.provider, 'fixture')
  assert.equal(resolution?.value, CREDENTIAL_VALUE)
  // The expanded plugin config carries the VALUE at runtime, never a reference.
  const command = kernel.registry.commands().find((entry) => entry.name === 'hello gated')
  assert.ok(command !== undefined)
  assert.equal(await command.run([]), CREDENTIAL_VALUE)
  assert.ok(!liveLines.some((line) => /hello-gated' is DEFERRED/.test(line)))
})

// The attribution seam of the CORE-PROVIDED service (`ctx.workbench`).
//
// A capability service reports who OWNS a registration (the tools inventory's
// `plugin` field, the web seam's owner) and must never trust a caller supplied
// name: it asks the HOST, which marks the plugin whose `apply` is running. That
// marker is `src/attribution.ts`; this test proves it is reachable on the REAL
// service the core provides (`ctx.workbench.attribution()`), not on a stub.
//
// Regression guard for the core-minimality move: the tools/web capability was
// moved to the plugins repository reading `ctx.workbench.attribution()`, and the
// host must answer it. Without this test a silent `unknown` owner (the tools
// inventory's fallback) would stay undetected by the unit tests that stub the
// host themselves.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'

const quiet = (): void => undefined

/** The attribution the probe plugin read while its `apply` was running. */
const PROBE = '__workbench_attribution_probe'

/**
 * Generates a one-plugin `path` source whose plugin reads the attribution
 * marker from the REAL provided service during its apply and exposes it both
 * through a global (for the test) and through a command (for a CLI-shaped read).
 */
function ownerProbeSource(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-attribution-'))
  const pluginDir = path.join(dir, 'owner-probe')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(
    path.join(pluginDir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'owner-probe',
        version: '0.1.0',
        description: 'test fixture: captures the host attribution marker while it applies',
        entry: 'index.js',
        capabilities: ['command:owner probe'],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(pluginDir, 'index.js'),
    `export const name = 'owner-probe'

export function apply(ctx) {
  // The REAL host service: the plugin asks who is registering right now. No
  // stub, no caller supplied name - exactly the read the tools/web capability
  // performs.
  globalThis.${PROBE} = ctx.workbench.attribution()
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'owner probe',
    description: 'reports the plugin the host attributed the registration to',
    run: () => globalThis.${PROBE},
  }))
}

export default { name, inject: ['workbench'], apply }
`,
  )
  return dir
}

test('the provided workbench service attributes a registration to the applying plugin', async () => {
  const sourceDir = ownerProbeSource()
  const kernel = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'core', path: sourceDir, external: false }],
      plugins: { 'owner-probe': {} },
    },
    configDir: sourceDir,
    log: quiet,
  })
  try {
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name), ['owner-probe'])

    // While the plugin applies, the host answers the applying plugin's name.
    assert.equal(
      (globalThis as Record<string, unknown>)[PROBE],
      'owner-probe',
      'ctx.workbench.attribution() must name the plugin whose apply is running',
    )

    // The same value through the service a plugin receives (`ctx.workbench`),
    // read from the kernel's own context rather than from a test double.
    const service = (kernel.ctx as unknown as { workbench: { attribution(): string } }).workbench
    assert.equal(typeof service.attribution, 'function', 'the provided service must expose attribution()')
    assert.equal(service.attribution(), 'core', 'outside a plugin apply the marker is the core itself')

    // The command registered by the plugin reports it too (the CLI-shaped read).
    assert.equal(await kernel.registry.resolve(['owner', 'probe'])?.command.run([]), 'owner-probe')

    // The commands the loader attributes post-hoc agree with the marker.
    assert.equal(kernel.registry.commands().find((command) => command.name === 'owner probe')?.plugin, 'owner-probe')
  } finally {
    delete (globalThis as Record<string, unknown>)[PROBE]
    await kernel.dispose()
    fs.rmSync(sourceDir, { recursive: true, force: true })
  }
})

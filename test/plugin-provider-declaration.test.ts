// Boot wiring for MANIFEST-DECLARED capabilities.
//
// A plugin whose manifest declares a capability (here a credentials provider)
// must be DECLARED to the core service BEFORE its `apply()` runs, on the BOOT
// path too. Otherwise `ctx.credentials.register()` throws
// "provider 'x' is not declared" and the plugin shows up as a load failure even
// though its manifest is correct. This test uses the boot path only (it never
// calls `kernel.credentials.declare` itself), so it fails if the kernel forgets
// to hand the declaration callback to the loader (`loader.ts` calls it right
// before a plugin is applied).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel } from '../src/kernel.ts'

const quiet = (): void => undefined

const MANIFEST = {
  name: 'boot-provider',
  version: '0.0.1',
  description: 'test fixture: an external plugin declaring the credentials provider boot-mock',
  entry: 'index.js',
  capabilities: [{ id: 'credentials', version: 1, provider: 'boot-mock' }],
}

const ENTRY = `
export function apply(ctx) {
  ctx.effect(() => ctx.credentials.register({
    id: 'boot-mock',
    version: 1,
    describe: () => 'boot fixture provider',
    resolve: (ref) => 'boot-' + ref.name,
  }))
}
export default { name: 'boot-provider', inject: ['credentials'], apply }
`

test('a provider plugin from a configured source is declared at boot: apply() registers it and resolve() answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-boot-provider-'))
  const sourceDir = path.join(dir, 'providers', 'boot-provider')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'workbench.plugin.json'), JSON.stringify(MANIFEST, null, 2) + '\n')
  fs.writeFileSync(path.join(sourceDir, 'index.js'), ENTRY)

  const kernel = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'providers', path: path.join(dir, 'providers'), external: true }],
      credentials: { providers: ['boot-mock'] },
    },
    configDir: dir,
    configFile: '(boot provider declaration test)',
    log: quiet,
  })
  try {
    // No failure: the plugin loaded, and its provider is the ENABLED one.
    assert.deepEqual(kernel.failures, [])
    assert.ok(
      kernel.plugins.some((plugin) => plugin.name === 'boot-provider'),
      'the provider plugin must be loaded at boot',
    )
    const resolution = await kernel.credentials.resolve({ name: 'DEMO' })
    assert.equal(resolution?.provider, 'boot-mock')
    assert.equal(resolution?.value, 'boot-DEMO')
  } finally {
    await kernel.dispose()
  }
})

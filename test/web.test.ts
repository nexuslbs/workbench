// Web seam + core web provider tests.
//
// The seam is the CONTRACT the UI plugins consume; the provider is the only
// module that touches a socket. Both are exercised here for real: the provider
// runs on an ephemeral port and every assertion goes through HTTP, so a broken
// route, asset or disposal path fails the test instead of passing on a mock.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from 'cordis'
import { CORE_PLUGINS } from './fixtures.ts'
import { createKernel } from '../src/kernel.ts'
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, WEB, Web, type WebPageInfo } from '../src/web/definition.ts'
import { renderShell } from '../src/web/providers/shell.ts'
import { createWebServer } from '../src/web/providers/http.ts'

/** A root context with the web SERVICE (the definition) provided, no provider. */
async function seam(): Promise<{ ctx: Context; web: Web }> {
  const ctx = new Context()
  let web!: Web
  await ctx.plugin({ name: WEB, apply: (c) => { web = new Web(c) } })
  return { ctx, web }
}

/** A plugin that registers one route, one asset and one page through `ctx.web`. */
function testUiPlugin(assetFile: string): { name: string; inject: string[]; apply(ctx: Context): void } {
  return {
    name: 'test-ui',
    inject: [WEB],
    apply(ctx: Context): void {
      const web = (ctx as Context & { web: Web })[WEB]
      ctx.effect(() => web.route({
        method: 'GET',
        path: '/api/test-ui/ping',
        description: 'test route',
        handler: () => ({ contentType: 'application/json; charset=utf-8', body: '{"pong":true}\n' }),
      }))
      ctx.effect(() => web.asset({ path: '/test-ui/app.js', file: assetFile }))
      ctx.effect(() => web.page({ id: 'test-ui', title: 'Test UI', path: '/test-ui', module: '/test-ui/app.js' }))
    },
  }
}

test('the web seam registers routes, assets and pages and disposes them with the plugin', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-web-'))
  const assetFile = path.join(dir, 'app.js')
  fs.writeFileSync(assetFile, 'export const mounted = true\n')
  const { ctx, web } = await seam()

  const fiber = await ctx.plugin(testUiPlugin(assetFile))
  assert.equal(web.pages().length, 1)
  assert.equal(web.assets().length, 1)
  assert.equal(web.routes().length, 1)
  const page: WebPageInfo = web.pages()[0]
  assert.equal(page.id, 'test-ui')
  assert.equal(page.path, '/test-ui')
  assert.equal(page.module, '/test-ui/app.js')
  assert.equal(web.routes().length, 1, 'the route registry is the source of truth')

  // Unloading the plugin must remove everything it registered: no leftover
  // route, asset or nav entry (disposal is part of the contract).
  await fiber.dispose()
  assert.deepEqual(web.pages(), [])
  assert.deepEqual(web.assets(), [])
  assert.deepEqual(web.routes(), [])
  await ctx.fiber.dispose()
})

test('the shell renders the nav from the registered pages and says so when there is none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-shell-'))
  const assetFile = path.join(dir, 'app.js')
  fs.writeFileSync(assetFile, 'export const mounted = true\n')
  const { ctx, web } = await seam()

  const empty = renderShell(web)
  assert.match(empty, /no UI plugin loaded/)
  assert.match(empty, /empty shell/)

  const fiber = await ctx.plugin(testUiPlugin(assetFile))
  const html = renderShell(web, '/test-ui')
  assert.match(html, /href="\/test-ui"/)
  assert.match(html, />Test UI</)
  assert.match(html, /nav-item active/)
  assert.match(html, /1 page\(s\) from 1 plugin\(s\)/)

  await fiber.dispose()
  await ctx.fiber.dispose()
})

test('the core provider serves the shell, the page index, assets and routes over HTTP', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-http-'))
  const assetFile = path.join(dir, 'app.js')
  fs.writeFileSync(assetFile, 'export const mounted = true\n')
  const { ctx, web } = await seam()
  const fiber = await ctx.plugin(testUiPlugin(assetFile))

  const server = await createWebServer(web, { host: '127.0.0.1', port: 0 })
  try {
    assert.equal(server.host, '127.0.0.1')
    assert.ok(server.port > 0, 'port 0 must be replaced by the effective port')
    assert.equal(server.url, `http://127.0.0.1:${server.port}`)

    const shell = await fetch(`${server.url}/`)
    assert.equal(shell.status, 200)
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/)
    const shellHtml = await shell.text()
    assert.match(shellHtml, /Test UI/)
    assert.match(shellHtml, /data-page="test-ui"/)

    const pages = await fetch(`${server.url}/api/web/pages`)
    assert.equal(pages.status, 200)
    const index = (await pages.json()) as { contract: string; pages: WebPageInfo[] }
    assert.equal(index.contract, 'web@1')
    assert.deepEqual(index.pages.map((page) => page.id), ['test-ui'])

    // A page path answers with the shell (the page module mounts itself).
    const pagePath = await fetch(`${server.url}/test-ui`)
    assert.equal(pagePath.status, 200)
    assert.match(await pagePath.text(), /Test UI/)

    // The asset is served VERBATIM from the plugin's own file - no build step.
    const asset = await fetch(`${server.url}/test-ui/app.js`)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('content-type') ?? '', /javascript/)
    assert.equal(await asset.text(), 'export const mounted = true\n')

    // A registered route is dispatched to its handler.
    const route = await fetch(`${server.url}/api/test-ui/ping`)
    assert.equal(route.status, 200)
    assert.deepEqual(await route.json(), { pong: true })

    // Anything else is a JSON 404 (never an HTML error page).
    const missing = await fetch(`${server.url}/nope`)
    assert.equal(missing.status, 404)
    assert.deepEqual(await missing.json(), { status: 'not found', method: 'GET', path: '/nope' })
  } finally {
    await server.close()
  }

  // Closing the provider unregisters what IT registered, and the plugin's own
  // registrations stay until the plugin unloads.
  assert.equal(web.assetAt('/api/web/pages'), undefined)
  assert.equal(web.pages().length, 1)
  await fiber.dispose()
  assert.deepEqual(web.pages(), [])
  await ctx.fiber.dispose()
})

test('the kernel serves the empty shell when no UI plugin is configured', async () => {
  const kernel = await createKernel({
    config: { sources: [{ kind: 'path', id: 'core', path: CORE_PLUGINS, external: false }] },
    configDir: path.dirname(CORE_PLUGINS),
    log: () => {},
  })
  try {
    assert.deepEqual(kernel.web.pages(), [], 'no UI plugin is configured')
    const server = await kernel.startWeb({ host: DEFAULT_WEB_HOST, port: 0 })
    const response = await fetch(`${server.url}/`)
    assert.equal(response.status, 200)
    const html = await response.text()
    assert.match(html, /no UI plugin loaded/)
    assert.match(html, /empty shell/)
    // Core-only config keeps working: the CLI surfaces are unaffected.
    assert.ok(kernel.plugins.some((plugin) => plugin.name === 'hello-world'))
  } finally {
    await kernel.dispose()
  }
})

test('the default web bind is loopback and the port is the documented one', () => {
  assert.equal(DEFAULT_WEB_HOST, '127.0.0.1')
  assert.equal(DEFAULT_WEB_PORT, 12348)
  assert.equal(WEB, 'web')
})

// Tools capability tests.
//
// The by-name invocation surface is a CONTRACT: a consumer plugin registers a
// named tool with the parameters it expects, and any caller (HTTP, CLI, in
// process) invokes it through ONE dispatch that validates first. Every HTTP
// assertion below goes through the real seam + `node:http` provider, so a broken
// route, a missing validation or a leaking registration fails here instead of
// passing on a mock.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Context } from 'cordis'
import { FIXTURE_PLUGINS } from './fixtures.ts'
import { createKernel } from '../src/kernel.ts'
import { CommandRegistry } from '../src/registry.ts'
import {
  TOOLS_CONTRACT,
  ToolArgsError,
  ToolRegistry,
  ToolUnknownError,
  parameterSchemaSpecToJsonSchema,
  validateArgs,
  type ParameterSchemaSpec,
  type ToolInfo,
} from '../src/tool-registry.ts'
import { registerToolRoutes } from '../src/tool-routes.ts'
// TEST DOUBLE: the real `web@1` Definition + provider moved to the EXTERNAL
// plugins repository, so the core tests use test/web-fixture.ts instead.
import { WEB, Web, createWebServer } from './web-fixture.ts'

/** The tool schema the fixtures below register: one required, two optional params. */
const GREET_PARAMETERS: ParameterSchemaSpec = {
  name: { type: 'string', description: 'who to greet', required: true },
  greeting: { type: 'string', description: 'greeting word' },
  times: { type: 'integer', description: 'how many times to greet' },
}

const TOOL_PLUGIN_ENTRY = `export const name = 'hello-tool'

export function apply(ctx, config = {}) {
  const label = config.label ?? 'hello-tool'
  ctx.effect(() => ctx.workbench.registerTool({
    name: 'hello greet',
    description: 'greets one person by name',
    parameters: {
      name: { type: 'string', description: 'who to greet', required: true },
      greeting: { type: 'string', description: 'greeting word' },
      times: { type: 'integer', description: 'how many times to greet' },
    },
    handler: (params) => ({
      message: Array.from({ length: params.times ?? 1 }, () => (params.greeting ?? 'Hello') + ', ' + params.name + '!').join(' '),
      label,
    }),
  }))
  ctx.effect(() => ctx.workbench.registerTool({
    name: 'explode',
    description: 'raises on purpose',
    handler: () => { throw new Error('boom') },
  }))
}

export default { name, inject: ['workbench'], apply }
`

interface ToolFixture {
  dir: string
  configFile: string
}

/** A temp external source with ONE plugin registering two tools, plus its config. */
function toolFixture(): ToolFixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-tools-'))
  const pluginDir = path.join(dir, 'hello-tool')
  fs.mkdirSync(pluginDir, { recursive: true })
  fs.writeFileSync(path.join(pluginDir, 'workbench.plugin.json'), JSON.stringify({
    name: 'hello-tool',
    version: '0.1.0',
    description: 'external test plugin: registers the "hello greet" tool',
    entry: 'index.js',
    capabilities: ['tool:hello greet', 'tool:explode'],
  }, null, 2) + '\n')
  fs.writeFileSync(path.join(pluginDir, 'index.js'), TOOL_PLUGIN_ENTRY)
  const configFile = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(configFile, [
    'sources:',
    '  - kind: path',
    '    id: core',
    `    path: ${JSON.stringify(FIXTURE_PLUGINS)}`,
    '    external: false',
    '  - kind: path',
    '    id: tools-fixture',
    '    path: .',
    '',
    'plugins:',
    '  hello-tool: {}',
    '',
  ].join('\n'))
  return { dir, configFile }
}

/** A root context with the web SERVICE (the definition) provided, no provider. */
async function seam(): Promise<{ ctx: Context; web: Web }> {
  const ctx = new Context()
  let web!: Web
  await ctx.plugin({ name: WEB, apply: () => { web = new Web() } })
  return { ctx, web }
}

/** A registry with the two fixture tools registered by hand (no plugin, no kernel). */
function registryWithTools(): CommandRegistry {
  const registry = new CommandRegistry(() => {})
  registry.registerTool({
    name: 'hello greet',
    description: 'greets one person by name',
    parameters: GREET_PARAMETERS,
    handler: (params) => ({
      message: Array.from({ length: params.times ?? 1 } as { length: number }, () => `${params.greeting ?? 'Hello'}, ${params.name}!`).join(' '),
      times: params.times ?? 1,
    }),
  })
  registry.registerTool({
    name: 'explode',
    description: 'raises on purpose',
    handler: () => { throw new Error('boom') },
  })
  return registry
}

test('validateArgs reports missing, mistyped and unknown parameters (readable, path-qualified)', () => {
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'Ada' }), [])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'Ada', greeting: 'Hi', times: 3 }), [])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, {}), ['name: missing required parameter'])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'Ada', times: '3' }), ['times: expected an integer, got string'])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, { name: 'Ada', nope: 1 }), ['nope: unknown parameter'])
  assert.deepEqual(validateArgs(GREET_PARAMETERS, 'nope'), ['params: expected an object, got string'])
  // Path-qualified for nested declarations, so a caller sees exactly where.
  const nested: ParameterSchemaSpec = {
    options: { type: 'object', required: true, properties: { loud: { type: 'boolean', required: true } } },
  }
  assert.deepEqual(validateArgs(nested, { options: {} }), ['options.loud: missing required parameter'])
  assert.deepEqual(validateArgs(nested, { options: { loud: 'yes' } }), ['options.loud: expected a boolean, got string'])
})

test('parameterSchemaSpecToJsonSchema folds per-property required into the JSON Schema root', () => {
  assert.deepEqual(parameterSchemaSpecToJsonSchema(GREET_PARAMETERS), {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'who to greet' },
      greeting: { type: 'string', description: 'greeting word' },
      times: { type: 'integer', description: 'how many times to greet' },
    },
    required: ['name'],
  })
  assert.deepEqual(parameterSchemaSpecToJsonSchema({}), { type: 'object', properties: {} })
})

test('the tool registry rejects a duplicate name, disposes cleanly and validates before the handler', async () => {
  const tools = new ToolRegistry()
  let calls = 0
  const dispose = tools.registerTool({
    name: 'count',
    description: 'counts calls',
    parameters: { step: { type: 'integer', required: true } },
    handler: (params) => { calls += 1; return { step: params.step, calls } },
  })
  assert.throws(() => tools.registerTool({ name: 'count', handler: () => 1 }), /already registered/)
  assert.deepEqual(tools.tools().map((tool) => tool.name), ['count'])
  assert.equal(tools.tools()[0]?.parameters.required?.[0], 'step')

  assert.deepEqual(await tools.execute('count', { step: 2 }), { step: 2, calls: 1 })
  await assert.rejects(tools.execute('count', {}), (error: unknown) => {
    assert.ok(error instanceof ToolArgsError)
    assert.deepEqual(error.violations, ['step: missing required parameter'])
    return true
  })
  assert.equal(calls, 1, 'the handler never ran for invalid params')
  await assert.rejects(tools.execute('nope', {}), (error: unknown) => {
    assert.ok(error instanceof ToolUnknownError)
    return true
  })

  dispose()
  assert.deepEqual(tools.tools(), [])
  await assert.rejects(tools.execute('count', { step: 1 }), /unknown tool 'count'/)
})

test('the tool HTTP surface answers the list, the descriptor, the invocation and the alias routes', async () => {
  const { ctx, web } = await seam()
  const registry = registryWithTools()
  registerToolRoutes(web, registry)
  const server = await createWebServer(web, { host: '127.0.0.1', port: 0 })
  try {
    // Discovery: every tool with name, description, plugin and parameter schema.
    const list = await fetch(`${server.url}/api/tools`)
    assert.equal(list.status, 200)
    const payload = (await list.json()) as { contract: string; count: number; tools: ToolInfo[] }
    assert.equal(payload.contract, TOOLS_CONTRACT)
    assert.equal(payload.count, 2)
    assert.deepEqual(payload.tools.map((tool) => tool.name), ['explode', 'hello greet'])
    const greet = payload.tools[1] as ToolInfo
    assert.equal(greet.description, 'greets one person by name')
    assert.equal(greet.plugin, 'core', 'no plugin marker: the core owns it')
    assert.deepEqual(greet.parameters.required, ['name'])
    assert.deepEqual(Object.keys(greet.parameters.properties), ['name', 'greeting', 'times'])

    // One descriptor (the name is a percent-encoded path segment: `hello greet`).
    const descriptor = await fetch(`${server.url}/api/tools/hello%20greet`)
    assert.equal(descriptor.status, 200)
    const one = (await descriptor.json()) as { tool: ToolInfo }
    assert.equal(one.tool.name, 'hello greet')

    // Invocation: the parameters ARE the body.
    const invoke = await fetch(`${server.url}/api/tools/hello%20greet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada', times: 2 }),
    })
    assert.equal(invoke.status, 200)
    const ok = (await invoke.json()) as { status: string; tool: string; result: { message: string; times: number } }
    assert.equal(ok.status, 'ok')
    assert.equal(ok.tool, 'hello greet')
    assert.deepEqual(ok.result, { message: 'Hello, Ada! Hello, Ada!', times: 2 })

    // Validation failures: 400 + the readable violations, never a silent coercion.
    const missing = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{}' })
    assert.equal(missing.status, 400)
    const missingBody = (await missing.json()) as { error: { kind: string; violations: string[] } }
    assert.equal(missingBody.error.kind, 'invalid-params')
    assert.deepEqual(missingBody.error.violations, ['name: missing required parameter'])

    const wrongType = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{"name":"Ada","times":"2"}' })
    assert.equal(wrongType.status, 400)
    assert.deepEqual(((await wrongType.json()) as { error: { violations: string[] } }).error.violations, ['times: expected an integer, got string'])

    const extra = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{"name":"Ada","nope":true}' })
    assert.equal(extra.status, 400)
    assert.deepEqual(((await extra.json()) as { error: { violations: string[] } }).error.violations, ['nope: unknown parameter'])

    const broken = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{oops' })
    assert.equal(broken.status, 400)
    assert.equal(((await broken.json()) as { error: { kind: string } }).error.kind, 'bad-request')

    // Unknown tool: 404 (a documented tool error, not the provider's 404 page).
    const unknown = await fetch(`${server.url}/api/tools/nope`, { method: 'POST', body: '{}' })
    assert.equal(unknown.status, 404)
    assert.equal(((await unknown.json()) as { error: { kind: string } }).error.kind, 'unknown-tool')

    // A throwing handler is a 500, and the server keeps serving.
    const failed = await fetch(`${server.url}/api/tools/explode`, { method: 'POST', body: '{}' })
    assert.equal(failed.status, 500)
    assert.equal(((await failed.json()) as { error: { kind: string } }).error.kind, 'tool-failed')
    const still = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{"name":"Ada"}' })
    assert.equal(still.status, 200, 'the process stays up after a handler error')

    // The alias bodies ({tool, params}) are the SAME dispatch: identical results.
    const aliasBody = JSON.stringify({ tool: 'hello greet', params: { name: 'Ada', greeting: 'Hi' } })
    const canonical = await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: JSON.stringify({ name: 'Ada', greeting: 'Hi' }) })
    const aliasTools = await fetch(`${server.url}/api/tools`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: aliasBody })
    const aliasCall = await fetch(`${server.url}/api/tool/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: aliasBody })
    assert.equal(aliasTools.status, 200)
    assert.equal(aliasCall.status, 200)
    const canonicalPayload = await canonical.json()
    assert.deepEqual(await aliasTools.json(), canonicalPayload)
    assert.deepEqual(await aliasCall.json(), canonicalPayload)

    // The alias validates the same way and reports a bad alias body as 400.
    const aliasBad = await fetch(`${server.url}/api/tool/call`, { method: 'POST', body: aliasBody.replace('"name":"Ada"', '"name":7') })
    assert.equal(aliasBad.status, 400)
    assert.deepEqual(((await aliasBad.json()) as { error: { violations: string[] } }).error.violations, ['name: expected a string, got number'])
    const aliasNoTool = await fetch(`${server.url}/api/tool/call`, { method: 'POST', body: '{"params":{}}' })
    assert.equal(aliasNoTool.status, 400)
    assert.equal(((await aliasNoTool.json()) as { error: { kind: string } }).error.kind, 'bad-request')
  } finally {
    await server.close()
  }
  await ctx.fiber.dispose()
})

test('a plugin that registers tools owns them, and unloading it disposes them (list + 404, then back)', async () => {
  const fixture = toolFixture()
  const kernel = await createKernel({
    config: {
      sources: [
        { kind: 'path', id: 'core', path: FIXTURE_PLUGINS, external: false },
        { kind: 'path', id: 'tools-fixture', path: '.' },
      ],
      plugins: { 'hello-tool': {} },
    },
    configDir: fixture.dir,
    log: () => {},
  })
  // The web PROVIDER (and with it the seam) lives in the EXTERNAL plugins
  // repository, so this core test registers the core's tool routes on the test
  // double and serves them itself: same routes, same dispatch, no core provider.
  const web = new Web()
  registerToolRoutes(web, kernel.registry)
  const server = await createWebServer(web, { host: '127.0.0.1', port: 0 })
  const names = async (): Promise<string[]> =>
    (((await (await fetch(`${server.url}/api/tools`)).json()) as { tools: ToolInfo[] }).tools.map((tool) => tool.name))
  const status = async (): Promise<number> => (await fetch(`${server.url}/api/tools/hello%20greet`, { method: 'POST', body: '{"name":"Ada"}' })).status
  try {
    assert.deepEqual(await names(), ['explode', 'hello greet'])
    const listed = (((await (await fetch(`${server.url}/api/tools`)).json()) as { tools: ToolInfo[] }).tools)[1] as ToolInfo
    assert.equal(listed.plugin, 'hello-tool', 'the inventory reports the owning plugin')
    assert.equal(await status(), 200)

    const unloaded = await kernel.host.unload('hello-tool')
    assert.equal(unloaded.ok, true)
    assert.deepEqual(await names(), [], 'the unloaded plugin left no tool behind')
    assert.equal(await status(), 404, 'an unloaded tool is no longer reachable')

    const loaded = await kernel.host.load('hello-tool')
    assert.equal(loaded.ok, true)
    assert.deepEqual(await names(), ['explode', 'hello greet'], 'loading it again re-registers its tools')
    assert.equal(await status(), 200)
  } finally {
    await server.close()
    await kernel.dispose()
  }
})

test('the CLI lists tools with their parameter schema and invokes them through the same dispatch', () => {
  const fixture = toolFixture()
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'src', 'cli.ts')
  const run = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const result = spawnSync(process.execPath, [cli, ...args, '--config', fixture.configFile], { encoding: 'utf8' })
    return { status: result.status, stdout: result.stdout, stderr: result.stderr }
  }

  const listed = run(['tools', '--json'])
  assert.equal(listed.status, 0, listed.stderr)
  const payload = JSON.parse(listed.stdout) as { contract: string; tools: ToolInfo[] }
  assert.equal(payload.contract, TOOLS_CONTRACT)
  assert.deepEqual(payload.tools.map((tool) => tool.name), ['explode', 'hello greet'])
  assert.deepEqual(payload.tools[1]?.parameters.required, ['name'], 'the CLI shows the schema')

  const human = run(['tools'])
  assert.equal(human.status, 0, human.stderr)
  assert.match(human.stdout, /hello greet  greets one person by name  \[hello-tool\]/)
  assert.match(human.stdout, /name \(required\): string/)

  const called = run(['tool', 'hello greet', '{"name":"Ada","greeting":"Hi"}'])
  assert.equal(called.status, 0, called.stderr)
  assert.deepEqual(JSON.parse(called.stdout), { status: 'ok', tool: 'hello greet', result: { message: 'Hi, Ada!', label: 'hello-tool' } })

  const invalid = run(['tool', 'hello greet', '{}'])
  assert.equal(invalid.status, 2, 'validation failure exits 2 and prints the violations')
  assert.match(invalid.stderr, /name: missing required parameter/)

  const unknown = run(['tool', 'nope', '{}'])
  assert.equal(unknown.status, 1)
  assert.match(unknown.stderr, /unknown tool 'nope'/)

  fs.rmSync(fixture.dir, { recursive: true, force: true })
})

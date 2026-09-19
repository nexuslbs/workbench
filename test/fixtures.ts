// Shared test fixtures.
//
// The core repository SHIPS NO PLUGINS (v0.0.2: every plugin lives in an
// external source, `nexuslbs/workbench-plugins`). The tests therefore exercise
// the loader against plugins that are created HERE, in a temp directory:
//
//   * FIXTURE_PLUGINS: a generated `path` source holding a `hello-world` plugin
//     with the same shape as the one that moved to the plugins repository - the
//     tests covering the LOCAL (non-external) source path use it,
//   * externalFixture(): a fully external source with an `hello-otherworld`
//     plugin, plus YAML/JSON configs that load both.
//
// No test may depend on a plugin directory of this repository: the repository
// has none, and `npm test` must pass without any plugins checkout.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_CONFIG = path.join(ROOT, 'workbench.config.yml')
export const EXAMPLE_CONFIG = path.join(ROOT, 'workbench.config.example.yml')

/** Manifest of the generated fixture plugin (mirrors the moved `hello-world`). */
const HELLO_WORLD_MANIFEST = {
  name: 'hello-world',
  version: '0.1.0',
  description: 'generated test fixture: registers the "hello world" command',
  entry: 'index.js',
  capabilities: ['command:hello world'],
}

const HELLO_WORLD_ENTRY = `export const name = 'hello-world'

export function apply(ctx, config = {}) {
  const message = config.message ?? 'Hello World'
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'hello world',
    description: 'prints the greeting',
    run: () => message,
  }))
}

export default { name, inject: ['workbench'], apply }
`

function writePlugin(dir: string, manifest: unknown, entry: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'workbench.plugin.json'), JSON.stringify(manifest, null, 2) + '\n')
  fs.writeFileSync(path.join(dir, 'index.js'), entry)
}

/**
 * A `path` source generated in a temp directory, holding the fixture
 * `hello-world` plugin. Tests declare it with the source id `core` - a label
 * for "the source that stands in for a local plugin source", NOT a directory of
 * this repository - and `external: false`, which is the local-source code path.
 */
export const FIXTURE_PLUGINS = ((): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-fixture-local-'))
  writePlugin(path.join(dir, 'hello-world'), HELLO_WORLD_MANIFEST, HELLO_WORLD_ENTRY)
  return dir
})()

export interface Fixture {
  /** Temp directory holding the external plugin source and the configs. */
  dir: string
  /** Config (YAML) declaring the local fixture source and the fixture external source. */
  yml: string
  /** The same config as JSON (parser parity). */
  json: string
  /** Directory of the fixture plugin (the external source). */
  sourceDir: string
}

const PLUGIN_MANIFEST = {
  name: 'hello-otherworld',
  version: '0.1.0',
  description: 'external test plugin: registers the "hello otherworld" command',
  entry: 'index.js',
  capabilities: ['command:hello otherworld'],
}

const PLUGIN_ENTRY = `export const name = 'hello-otherworld'

export function apply(ctx, config = {}) {
  const message = config.message ?? 'Hello Otherworld'
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'hello otherworld',
    description: 'prints the external greeting',
    run: () => message,
  }))
}

export default { name, inject: ['workbench'], apply }
`

function pluginEntries(): { name: string; message: string }[] {
  return [
    { name: 'hello-world', message: 'Hello World' },
    { name: 'hello-otherworld', message: 'Hello Otherworld' },
  ]
}

function configValue(): { sources: unknown[]; plugins: Record<string, { message: string }> } {
  return {
    sources: [
      { kind: 'path', id: 'core', path: FIXTURE_PLUGINS, external: false },
      { kind: 'path', id: 'external-plugins', path: '.' },
    ],
    plugins: Object.fromEntries(pluginEntries().map(({ name, message }) => [name, { message }])),
  }
}

/** Creates a temp external plugin source (one plugin) plus YAML and JSON configs loading it. */
export function externalFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-fixture-'))
  const sourceDir = path.join(dir, 'hello-otherworld')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(path.join(sourceDir, 'workbench.plugin.json'), JSON.stringify(PLUGIN_MANIFEST, null, 2) + '\n')
  fs.writeFileSync(path.join(sourceDir, 'index.js'), PLUGIN_ENTRY)

  const yml = [
    '# test fixture: local (generated) source + a temp external source',
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
    ...pluginEntries().map(({ name, message }) => `  ${name}:\n    message: ${JSON.stringify(message)}`),
    '',
  ].join('\n')
  const json = JSON.stringify(configValue(), null, 2) + '\n'

  const ymlFile = path.join(dir, 'workbench.config.yml')
  const jsonFile = path.join(dir, 'workbench.config.json')
  fs.writeFileSync(ymlFile, yml)
  fs.writeFileSync(jsonFile, json)
  return { dir, yml: ymlFile, json: jsonFile, sourceDir }
}

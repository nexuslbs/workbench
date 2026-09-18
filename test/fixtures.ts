// Shared test fixtures.
//
// The external plugin used by the tests is created in a TEMP directory instead
// of pointing at the sibling `workbench-plugins` checkout: the core repo has no
// dependency on any plugin repository, so `npm test` must pass without one.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const CORE_PLUGINS = path.join(ROOT, 'plugins')
export const DEFAULT_CONFIG = path.join(ROOT, 'workbench.config.yml')
export const EXAMPLE_CONFIG = path.join(ROOT, 'workbench.config.example.yml')

export interface Fixture {
  /** Temp directory holding the external plugin source and the configs. */
  dir: string
  /** Config (YAML) declaring the core source and the fixture external source. */
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
      { kind: 'path', id: 'core', path: CORE_PLUGINS, external: false },
      { kind: 'path', id: 'workbench-plugins', path: '.' },
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
    '# test fixture: core source + a temp external source',
    'sources:',
    '  - kind: path',
    '    id: core',
    `    path: ${JSON.stringify(CORE_PLUGINS)}`,
    '    external: false',
    '  - kind: path',
    '    id: workbench-plugins',
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

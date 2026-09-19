// Unit/behaviour tests of the config loader: extension driven parsing (JSON and
// YAML), default-file resolution order, ${env:VAR} expansion, and the errors a
// broken or unknown-format config must produce. The end-to-end kernel tests live
// in kernel.test.ts.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DEFAULT_CONFIG_FILES,
  configFormat,
  findDefaultConfigFile,
  readConfig,
  resolveDefaultConfigFile,
} from '../src/config.ts'
import { createKernel } from '../src/kernel.ts'
import { DEFAULT_CONFIG, EXAMPLE_CONFIG, ROOT, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

test('a YAML config yields the same kernel state as the equivalent JSON one (parity)', async () => {
  const fixture = externalFixture()
  const fromYaml = readConfig(fixture.yml)
  const fromJson = readConfig(fixture.json)
  try {
    assert.deepEqual(fromYaml.config, fromJson.config)
    assert.equal(fromYaml.dir, fromJson.dir)
    assert.equal(fromYaml.file, fixture.yml)

    const yaml = await createKernel({ configFile: fixture.yml, log: quiet })
    const json = await createKernel({ configFile: fixture.json, log: quiet })
    try {
      assert.deepEqual(
        yaml.plugins.map((plugin) => [plugin.name, plugin.source, plugin.external]),
        json.plugins.map((plugin) => [plugin.name, plugin.source, plugin.external]),
      )
      assert.equal(await yaml.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
      assert.equal(await json.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    } finally {
      await yaml.dispose()
      await json.dispose()
    }
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

test('YAML config values expand ${env:VAR} references', () => {
  const dir = tempDir('workbench-env')
  const file = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(file, 'sources:\n  - kind: path\n    path: "${env:WORKBENCH_YAML_SOURCE}"\n')
  process.env.WORKBENCH_YAML_SOURCE = './from-env'
  try {
    const loaded = readConfig(file)
    assert.equal(loaded.config.sources[0].path, './from-env')
  } finally {
    delete process.env.WORKBENCH_YAML_SOURCE
  }
  process.env.WORKBENCH_YAML_MISSING = ''
  assert.throws(() => readConfig(file), /env var WORKBENCH_YAML_SOURCE referenced by the workbench config is not set/)
  delete process.env.WORKBENCH_YAML_MISSING
})

test('default config resolution prefers .yml, then .yaml, then .json', () => {
  assert.deepEqual([...DEFAULT_CONFIG_FILES], ['workbench.config.yml', 'workbench.config.yaml', 'workbench.config.json'])
  const dir = tempDir('workbench-order')
  assert.equal(resolveDefaultConfigFile(dir), undefined)

  fs.writeFileSync(path.join(dir, 'workbench.config.json'), '{"sources": []}')
  assert.equal(path.basename(resolveDefaultConfigFile(dir) ?? ''), 'workbench.config.json')

  fs.writeFileSync(path.join(dir, 'workbench.config.yaml'), 'sources: []')
  assert.equal(path.basename(resolveDefaultConfigFile(dir) ?? ''), 'workbench.config.yaml')

  fs.writeFileSync(path.join(dir, 'workbench.config.yml'), 'sources: []')
  assert.equal(path.basename(resolveDefaultConfigFile(dir) ?? ''), 'workbench.config.yml')
})

test('the repo default config is workbench.config.yml (core-only)', () => {
  assert.equal(resolveDefaultConfigFile(ROOT), DEFAULT_CONFIG)
  assert.equal(findDefaultConfigFile([ROOT]), DEFAULT_CONFIG)
  const loaded = readConfig(DEFAULT_CONFIG)
  assert.deepEqual(loaded.config.sources, [], 'the core default config declares no source (the core ships ZERO plugins)')
})

test('a missing default config names every candidate file', () => {
  const dir = tempDir('workbench-missing')
  assert.throws(
    () => findDefaultConfigFile([dir]),
    (error: Error) => {
      for (const name of DEFAULT_CONFIG_FILES) assert.ok(error.message.includes(name), `error must name ${name}: ${error.message}`)
      return true
    },
  )
})

test('malformed YAML raises an error naming the file and the position', () => {
  const dir = tempDir('workbench-broken')
  const file = path.join(dir, 'workbench.config.yml')
  // a tab is never valid YAML indentation
  fs.writeFileSync(file, 'sources:\n\t- kind: path\n')
  assert.throws(
    () => readConfig(file),
    (error: Error) => {
      assert.match(error.message, new RegExp(`^config ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: invalid YAML`))
      assert.match(error.message, /line 2/)
      return true
    },
  )
})

test('an unknown config extension is an explicit error (no guessing)', () => {
  const dir = tempDir('workbench-ext')
  const file = path.join(dir, 'workbench.config.toml')
  fs.writeFileSync(file, 'sources = []\n')
  assert.throws(() => readConfig(file), /unsupported config extension '\.toml' \(expected \.json, \.yml or \.yaml\)/)
  assert.throws(() => configFormat(path.join(dir, 'workbenchconf')), /unsupported config extension '\(none\)'/)
})

test('non-string YAML scalars are reported by the validation messages', () => {
  const dir = tempDir('workbench-types')
  const file = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(file, 'sources:\n  - kind: 42\n')
  assert.throws(() => readConfig(file), /source kind must be 'path' or 'git' \(got 42\)/)

  fs.writeFileSync(file, 'sources:\n  - kind: path\n    path: 42\n')
  assert.throws(() => readConfig(file), /a 'path' source needs a 'path' string \(got 42\)/)

  fs.writeFileSync(file, 'sources: {}\n')
  assert.throws(() => readConfig(file), /'sources' must be an array \(got object\)/)
})

test('CLI (documented smoke) boots the plugin-less YAML example config', () => {
  const listed = spawnSync(process.execPath, ['src/cli.ts', '--config', EXAMPLE_CONFIG, 'plugins'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  assert.match(listed.stdout, /workbench: 0 plugin\(s\) loaded \(0 core, 0 external\)/)

  // The example documents every shape a deployment needs - including the PRIVATE
  // git source whose credential is a reference BY NAME, never a value.
  const example = fs.readFileSync(EXAMPLE_CONFIG, 'utf8')
  assert.match(example, /url: https:\/\/github\.com\/nexuslbs\/workbench-plugins-private/)
  assert.match(example, /type: github-app/)
  assert.match(example, /credential: GITHUB_APP_KEY/)
  assert.doesNotMatch(example, /-----BEGIN|ghp_|sk-/)
})

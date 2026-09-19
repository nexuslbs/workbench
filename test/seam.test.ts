// The seam rules are enforced by `scripts/check-seam.ts` (also exposed as
// `npm run check:seam`): dependency direction only Provider -> Definition <-
// Consumer. This test pins the check itself: it must pass on this repository
// and it must FAIL on each of the three forbidden import directions, so the
// check cannot rot into a no-op.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { checkSeam } from '../scripts/check-seam.ts'
import { ROOT } from './fixtures.ts'

function fixtureRoot(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-seam-'))
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  return root
}

function summary(root: string): string[] {
  return checkSeam(root).violations.map(
    (violation) => `${violation.file} (${violation.layer}) -> ${violation.target} (${violation.targetLayer})`,
  )
}

test('this repository respects Provider -> Definition <- Consumer', () => {
  const { scanned, violations } = checkSeam(ROOT)
  assert.ok(scanned >= 10, `expected the check to scan the core modules (scanned ${scanned})`)
  assert.deepEqual(violations, [])
})

test('the check FAILS when a PROVIDER imports a CONSUMER', () => {
  const root = fixtureRoot({
    'src/config.ts': 'export const config = 1\n',
    'src/credentials/providers/p.ts': "import { config } from '../../config.ts'\nexport const p = config\n",
  })
  assert.deepEqual(summary(root), ['src/credentials/providers/p.ts (provider) -> src/config.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a CONSUMER imports a PROVIDER', () => {
  const root = fixtureRoot({
    'src/credentials/providers/p.ts': 'export const p = 1\n',
    'src/config.ts': "import { p } from './credentials/providers/p.ts'\nexport const config = p\n",
  })
  assert.deepEqual(summary(root), ['src/config.ts (consumer) -> src/credentials/providers/p.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a PLUGIN imports a PROVIDER module', () => {
  const root = fixtureRoot({
    'src/credentials/providers/p.ts': 'export const p = 1\n',
    'plugins/acme/index.ts': "import { p } from '../../src/credentials/providers/p.ts'\nexport default p\n",
  })
  assert.deepEqual(summary(root), ['plugins/acme/index.ts (plugin) -> src/credentials/providers/p.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a CONSUMER imports an EMAIL provider module', () => {
  const root = fixtureRoot({
    'src/email/providers/himalaya.ts': 'export const himalaya = 1\n',
    'src/cli.ts': "import { himalaya } from './email/providers/himalaya.ts'\nexport const cli = himalaya\n",
  })
  assert.deepEqual(summary(root), ['src/cli.ts (consumer) -> src/email/providers/himalaya.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a PLUGIN imports the EMAIL provider module of another capability', () => {
  const root = fixtureRoot({
    'src/email/providers/himalaya.ts': 'export const himalaya = 1\n',
    'src/email/definition.ts': 'export const definition = 1\n',
    'plugins/email-tools/index.ts': "import { himalaya } from '../../src/email/providers/himalaya.ts'\nexport default himalaya\n",
  })
  assert.deepEqual(summary(root), ['plugins/email-tools/index.ts (plugin) -> src/email/providers/himalaya.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when the EMAIL DEFINITION imports a consumer (the contract depends on nobody)', () => {
  const root = fixtureRoot({
    'src/config.ts': 'export const config = 1\n',
    'src/email/definition.ts': "import { config } from '../config.ts'\nexport const definition = config\n",
  })
  assert.deepEqual(summary(root), ['src/email/definition.ts (definition) -> src/config.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a CONSUMER imports a TOTP provider module', () => {
  const root = fixtureRoot({
    'src/totp/providers/rfc6238.ts': 'export const rfc6238 = 1\n',
    'src/cli.ts': "import { rfc6238 } from './totp/providers/rfc6238.ts'\nexport const cli = rfc6238\n",
  })
  assert.deepEqual(summary(root), ['src/cli.ts (consumer) -> src/totp/providers/rfc6238.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when the TOTP DEFINITION imports a consumer (the contract depends on nobody)', () => {
  const root = fixtureRoot({
    'src/config.ts': 'export const config = 1\n',
    'src/totp/definition.ts': "import { config } from '../config.ts'\nexport const definition = config\n",
  })
  assert.deepEqual(summary(root), ['src/totp/definition.ts (definition) -> src/config.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when the DEFINITION imports a consumer (the contract depends on nobody)', () => {
  const root = fixtureRoot({
    'src/cli.ts': 'export const cli = 1\n',
    'src/credentials/definition.ts': "import { cli } from '../cli.ts'\nexport const definition = cli\n",
  })
  assert.deepEqual(summary(root), ['src/credentials/definition.ts (definition) -> src/cli.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

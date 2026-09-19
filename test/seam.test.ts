// The seam rules are enforced by `scripts/check-seam.ts` (also exposed as
// `npm run check:seam`): dependency direction only Provider -> Definition <-
// Consumer. This test pins the check itself: it must pass on this repository and
// it must FAIL on each forbidden import direction, so the check cannot rot into a
// no-op.
//
// v0.0.2: the core ships NO plugin and, of the capability implementations, only
// the `web` serve providers (`src/web/providers/`). The credential providers
// moved to the PUBLIC `nexuslbs/workbench-plugins` repository as the plugin
// `credentials-basic`; `email`, `sms`, `totp` and the tool registry are plugin
// concerns. The fixtures below therefore use `src/web/providers/` and
// `src/credentials/providers/` - the latter is an empty directory kept under the
// rule so a provider module placed there is still classified as a provider.
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
    'src/web/providers/p.ts': "import { config } from '../../config.ts'\nexport const p = config\n",
  })
  assert.deepEqual(summary(root), ['src/web/providers/p.ts (provider) -> src/config.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a CONSUMER imports a PROVIDER', () => {
  const root = fixtureRoot({
    'src/web/providers/p.ts': 'export const p = 1\n',
    'src/config.ts': "import { p } from './web/providers/p.ts'\nexport const config = p\n",
  })
  assert.deepEqual(summary(root), ['src/config.ts (consumer) -> src/web/providers/p.ts (provider)'])
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

test('the check FAILS when a CONSUMER imports a CREDENTIALS provider module', () => {
  const root = fixtureRoot({
    'src/credentials/providers/p.ts': 'export const p = 1\n',
    'src/cli.ts': "import { p } from './credentials/providers/p.ts'\nexport const cli = p\n",
  })
  assert.deepEqual(summary(root), ['src/cli.ts (consumer) -> src/credentials/providers/p.ts (provider)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when a DEFINITION imports a consumer (the contract depends on nobody)', () => {
  const root = fixtureRoot({
    'src/config.ts': 'export const config = 1\n',
    'src/web/definition.ts': "import { config } from '../config.ts'\nexport const definition = config\n",
  })
  assert.deepEqual(summary(root), ['src/web/definition.ts (definition) -> src/config.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

test('the check FAILS when the CREDENTIALS DEFINITION imports a consumer', () => {
  const root = fixtureRoot({
    'src/cli.ts': 'export const cli = 1\n',
    'src/credentials/definition.ts': "import { cli } from '../cli.ts'\nexport const definition = cli\n",
  })
  assert.deepEqual(summary(root), ['src/credentials/definition.ts (definition) -> src/cli.ts (consumer)'])
  fs.rmSync(root, { recursive: true, force: true })
})

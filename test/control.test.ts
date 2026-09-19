// The OUT-OF-BAND converge path: the core serves `host.reconcile()` over a unix
// domain socket, so a process whose roster loaded NO management plugin at all can
// still apply a config edit - no HTTP route, no plugin, no extra port.
//
// Covered: the socket path derivation (and its env override), the ping /
// inventory / reconcile protocol over a REAL socket, the structured refusals,
// the ownership rules (a LIVE channel is never stolen by a second boot, a stale
// socket FILE is taken over), and the WHOLE flow against a REAL kernel boot:
// with the process running a minimal roster, the config file is edited and the
// RUNNING tree converges through the channel.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  CONTROL_SOCKET_ENV,
  callControlChannel,
  controlSocketPath,
  pingControlChannel,
  reconcileViaControlChannel,
  startControlChannel,
} from '../src/control.ts'
import { createKernel } from '../src/kernel.ts'
import type { HostInventory, HostReconcileReport } from '../src/types.ts'
import { FIXTURE_PLUGINS, externalFixture } from './fixtures.ts'

const quiet = (): void => undefined

/** Writes the fixture config with the given `plugins:` block (the roster). */
function writeConfig(fixtureDir: string, file: string, roster: string[]): string {
  const target = path.join(fixtureDir, file)
  fs.writeFileSync(
    target,
    [
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
      ...roster,
      '',
    ].join('\n'),
  )
  return target
}

/** One roster line pair for a plugin row with a `message`. */
function row(name: string, message: string): string[] {
  return [`  ${name}:`, `    message: ${JSON.stringify(message)}`]
}

test('controlSocketPath: derived from the config file, overridable by the environment', () => {
  const a = controlSocketPath('/etc/workbench/a.yml', {})
  const same = controlSocketPath('/etc/workbench/a.yml', {})
  const other = controlSocketPath('/etc/workbench/b.yml', {})
  assert.equal(a, same, 'the same config file always maps to the same socket')
  assert.notEqual(a, other, 'two config files never share a control socket')
  assert.match(a, /workbench-control-[0-9a-f]{12}\.sock$/)
  assert.equal(controlSocketPath('/etc/workbench/a.yml', { [CONTROL_SOCKET_ENV]: '/run/wb.sock' }), '/run/wb.sock')
  assert.equal(controlSocketPath('/etc/workbench/a.yml', { [CONTROL_SOCKET_ENV]: '   ' }), a, 'a blank override means unset')
})

test('the control channel answers ping/inventory/reconcile, refuses junk, and is never stolen while it is live', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-control-'))
  const socketPath = path.join(dir, 'control.sock')
  // A leftover socket FILE (a killed process, a stale mount) must be taken over:
  // it answers nothing, so a boot that refuses to start would strand the process.
  fs.writeFileSync(socketPath, '')
  let reconciles = 0
  const channel = await startControlChannel({
    socketPath,
    configFile: path.join(dir, 'config.yml'),
    inventory: () => ({ plugins: [{ name: 'hello-world' }] }) as unknown as HostInventory,
    reconcile: async () => {
      reconciles += 1
      return { ok: true, loaded: 3 } as unknown as HostReconcileReport
    },
    log: quiet,
  })
  if (channel === undefined) throw new Error('the control channel must be served when the path is free')
  try {
    const ping = await pingControlChannel(socketPath)
    assert.equal(ping?.ok, true)
    assert.equal(ping?.op, 'ping')
    assert.equal(ping?.pid, process.pid, 'the answer names the process that serves it')

    const inventory = await callControlChannel(socketPath, { op: 'inventory' })
    assert.equal(inventory.plugins, 1)

    const reconciled = await reconcileViaControlChannel(socketPath)
    assert.equal(reconciles, 1)
    assert.equal((reconciled?.report as { loaded: number }).loaded, 3)

    // Structured refusals: the channel never crashes on a bad request.
    const unknown = await callControlChannel(socketPath, { op: 'nope' as never })
    assert.equal(unknown.ok, false)
    assert.match(unknown.error ?? '', /unknown op 'nope'/)

    // ONE owner: a second process must never steal a LIVE channel (that would
    // leave the running one unreachable for good).
    const second = await startControlChannel({
      socketPath,
      configFile: path.join(dir, 'config.yml'),
      inventory: () => ({}) as unknown as HostInventory,
      reconcile: async () => ({}) as unknown as HostReconcileReport,
      log: quiet,
    })
    assert.equal(second, undefined, 'the live channel keeps its owner')
    assert.equal((await pingControlChannel(socketPath))?.pid, process.pid, 'and still answers the first process')
  } finally {
    await channel.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(fs.existsSync(socketPath), false, 'close() removes the socket file')
  // With nothing live the CLI falls back to a one-shot converge instead of hanging.
  assert.equal(await pingControlChannel(socketPath, 200), undefined)
  assert.equal(await reconcileViaControlChannel(socketPath, 200), undefined)
})

test('out-of-band: a MINIMAL roster converges through the channel of the RUNNING process (no restart)', async () => {
  const fixture = externalFixture()
  const configFile = writeConfig(fixture.dir, 'control-converge.yml', row('hello-world', 'Hello World'))
  const kernel = await createKernel({ configFile, log: quiet })
  // The situation of the production service: a roster that loaded no management
  // plugin, so the process has no in-process mutation surface AT ALL.
  const surface = kernel.host.inventory().mutationSurface
  assert.equal(surface.loaded, false)
  assert.equal(surface.controlSocket, controlSocketPath(configFile))
  assert.match(surface.remedy, /workbench reconcile/)
  assert.match(surface.remedy, /restart/)

  const channel = await startControlChannel({
    socketPath: controlSocketPath(configFile),
    configFile,
    inventory: () => kernel.host.inventory(),
    reconcile: () => kernel.host.reconcile(),
    log: quiet,
  })
  if (channel === undefined) throw new Error('the control channel must be served')
  try {
    // The operator EDITS THE FILE while the process runs (the desired state).
    writeConfig(fixture.dir, 'control-converge.yml', [...row('hello-world', 'Hello World'), ...row('hello-otherworld', 'Hello Otherworld')])

    // The out-of-band call carries the SAME operation the host exposes.
    const answer = await reconcileViaControlChannel(channel.socketPath)
    assert.equal(answer?.ok, true, answer?.error)
    const report = answer.report
    assert.equal(report?.ok, true, report?.message)
    assert.deepEqual(
      report?.changes.map((change) => [change.name, change.action]).sort(),
      [
        ['hello-otherworld', 'load'],
        ['hello-world', 'unchanged'],
      ],
    )
    // The RUNNING process really changed: the newly rostered plugin answers now.
    assert.equal(await kernel.registry.resolve(['hello', 'otherworld'])?.command.run([]), 'Hello Otherworld')
    assert.deepEqual(kernel.plugins.map((plugin) => plugin.name).sort(), ['hello-otherworld', 'hello-world'])

    // The channel reports the live inventory too (what the CLI/curl would read).
    const inventory = await callControlChannel(channel.socketPath, { op: 'inventory' })
    assert.equal(inventory.inventory?.plugins.length, 2)

    // IDEMPOTENT: a second converge with an unchanged file is an empty delta.
    const again = await reconcileViaControlChannel(channel.socketPath)
    assert.equal(again?.ok, true)
    assert.deepEqual(again?.report?.changes.map((change) => change.action).sort(), ['unchanged', 'unchanged'])

    // The CLI decides on a per-plugin report even when a row FAILED: the exit
    // code comes from `report.ok`, and the channel still answers.
    writeConfig(fixture.dir, 'control-converge.yml', [
      ...row('hello-world', 'Hello World'),
      ...row('hello-otherworld', 'Hello Otherworld'),
      '  does-not-exist:',
      '    message: nope',
    ])
    const bogus = await reconcileViaControlChannel(channel.socketPath)
    assert.equal(bogus?.report?.ok, false, 'the bogus row is reported, it is not silently ignored')
    assert.deepEqual(bogus?.report?.errors, ['does-not-exist'])
    assert.equal((await pingControlChannel(channel.socketPath))?.pid, process.pid, 'the process stays alive')
  } finally {
    await channel.close()
    await kernel.dispose()
    fs.rmSync(fixture.dir, { recursive: true, force: true })
  }
})

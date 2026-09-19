// Regression test of the SERVE seam: when the config enables the Web UI on the
// SAME port as the status endpoint, `workbench serve` must expose both on ONE
// listener - the browser UI (HTML shell) AND `/health` (the status JSON the
// compose healthcheck probes). That is what lets the dev overlay keep publishing
// a single port (12347) while the operator gets a browser UI there.
//
// It runs the REAL CLI in a child process (like the `serve` test in
// kernel.test.ts) and talks HTTP to it, so a regression in the merge is caught
// by behaviour, not by reading flags.
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { CORE_PLUGINS, ROOT } from './fixtures.ts'

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => (port ? resolve(port) : reject(new Error('no free port'))))
    })
  })
}

/** Waits until the server answers (or fails after `timeoutMs`). */
async function waitForAnswer(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`serve did not answer on port ${port} within ${timeoutMs}ms`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

test('serve merges the Web UI and /health on one listener when the web port is the status port', async () => {
  const port = await freePort()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-serve-merge-'))
  const configFile = path.join(dir, 'config.yml')
  fs.writeFileSync(
    configFile,
    [
      'sources:',
      '  - kind: path',
      '    id: core',
      `    path: ${CORE_PLUGINS}`,
      '    external: false',
      // ROSTER semantics: the config NAMES the plugins to load; a discovered
      // plugin without a row here is only available.
      'plugins:',
      '  hello-world: {}',
      'web:',
      '  enabled: true',
      '  host: 127.0.0.1',
      `  port: ${port}`,
      '',
    ].join('\n'),
  )

  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'cli.ts'), 'serve', '--config', configFile, '--port', String(port)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))
  child.stderr?.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')))

  try {
    await waitForAnswer(port)

    // The browser UI: the shell is HTML and is served on the SAME port.
    const shell = await fetch(`http://127.0.0.1:${port}/`)
    assert.equal(shell.status, 200)
    assert.match(shell.headers.get('content-type') ?? '', /text\/html/)
    const html = await shell.text()
    assert.match(html, /<!doctype html>/i)

    // The status endpoint the compose healthcheck probes still answers here.
    const health = await fetch(`http://127.0.0.1:${port}/health`)
    assert.equal(health.status, 200)
    assert.match(health.headers.get('content-type') ?? '', /application\/json/)
    const status = (await health.json()) as { status?: string; plugins?: { name: string }[]; sources?: unknown[] }
    assert.equal(status.status, 'ok')
    assert.ok(status.plugins?.some((plugin) => plugin.name === 'hello-world'))

    // The merged listener is announced as such (one port, both surfaces).
    assert.match(stdout, /one listener with the status endpoint/)
  } finally {
    await stop(child)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

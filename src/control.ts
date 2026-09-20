// The OUT-OF-BAND control channel of a RUNNING workbench process.
//
// WHY THE CORE OWNS IT (operator case, 2026-09-19): the in-process mutation
// surface of a deployment IS ITSELF plugins (`plugin-manager`, `settings`,
// `plugin-inventory`, and the `web@1` provider that hosts the routes). A process
// that booted a MINIMAL roster therefore exposes NO action to call - the whole
// `/api/plugin-manager/action` route simply does not exist - so the only way to
// apply a config edit was to restart it. This channel keeps the converge
// operation reachable on a process that loaded NOTHING but the config.
//
// It is a UNIX DOMAIN SOCKET: no TCP port, no HTTP server, no web dependency and
// no plugin is involved, so the core-minimum rule holds (the core still owns no
// listener a product needs, and nothing a deployment serves goes through this).
//
// It EXTENDS the reconcile work of `host.reconcile()`
// (task_workbench_workbench_core_add_host_reconcile): the operation it exposes
// IS `host.reconcile()` - this module adds the TRANSPORT, never a second diff.

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import type { HostInventory, HostReconcileReport, HostSourceRefreshReport, SourceRefreshOptions } from './types.ts'

/** Environment variable overriding the control-socket path (both sides read it). */
export const CONTROL_SOCKET_ENV = 'WORKBENCH_CONTROL_SOCKET'

/** Version of the line protocol, so a client can refuse a foreign socket. */
export const CONTROL_PROTOCOL_VERSION = 1

/** The operations the channel answers. */
export type ControlOp = 'ping' | 'inventory' | 'reconcile' | 'sources-update'

/** One request line (newline delimited JSON). */
export interface ControlRequest {
  op: ControlOp
  /** `sources-update`: refresh ONLY these source ids (default: every plugin source). */
  ids?: string[]
  /** `sources-update`: only READ the source state - no fetch, no install, no re-import. */
  list?: boolean
}

/** One response line: always `ok` plus the pid of the process that answered. */
export interface ControlResponse {
  ok: boolean
  protocol: number
  op: string
  pid: number
  socket: string
  configFile?: string
  plugins?: number
  inventory?: HostInventory
  report?: HostReconcileReport
  /** Answer of the `sources-update` op. */
  refresh?: HostSourceRefreshReport
  error?: string
}

/**
 * The control-socket path of the process booted from `configFile`:
 * `$WORKBENCH_CONTROL_SOCKET` when set, else a per-config-file path in the
 * temporary directory. BOTH sides (the running process and the CLI) derive it
 * from the SAME config resolution, which is why `workbench reconcile` reaches
 * the process the config belongs to and never a stranger's socket.
 */
export function controlSocketPath(configFile: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CONTROL_SOCKET_ENV]?.trim()
  if (override) return override
  const key = crypto.createHash('sha1').update(path.resolve(configFile)).digest('hex').slice(0, 12)
  return path.join(os.tmpdir(), `workbench-control-${key}.sock`)
}

export interface ControlChannelOptions {
  socketPath: string
  configFile: string
  inventory: () => HostInventory
  reconcile: () => Promise<HostReconcileReport>
  /**
   * The SOURCE refresh of THIS process (`host.refreshSources()`): `update`
   * fetches and force-checks-out the configured ref in place, `list` only READS
   * the state. Omitted by a caller that does not expose the operation - the
   * channel then REFUSES it by name instead of reporting a silent success.
   */
  refreshSources?: (options: SourceRefreshOptions) => Promise<HostSourceRefreshReport>
  log: (message: string) => void
}

export interface ControlChannel {
  socketPath: string
  close: () => Promise<void>
}

/**
 * Serves the channel for THIS process. Returns `undefined` (never throws) when
 * the channel cannot be served - another live process already owns that socket,
 * the path is unusable - so a control-surface problem can never stop a boot.
 */
export async function startControlChannel(options: ControlChannelOptions): Promise<ControlChannel | undefined> {
  const { socketPath } = options
  // One owner per socket: a LIVE channel is never stolen (that would leave the
  // running process unreachable for good). A leftover socket FILE from a killed
  // process answers nothing, so it is taken over.
  const live = await pingControlChannel(socketPath, 500)
  if (live !== undefined) {
    options.log(`control: ${socketPath} is already served by pid ${live.pid}; this process keeps no control channel`)
    return undefined
  }
  try {
    fs.rmSync(socketPath, { force: true })
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
  } catch (error) {
    options.log(`control: cannot prepare ${socketPath} (${(error as Error).message}); continuing without a control channel`)
    return undefined
  }

  const answer = (op: string, extra: Partial<ControlResponse> = {}): ControlResponse => ({
    ok: true,
    protocol: CONTROL_PROTOCOL_VERSION,
    op,
    pid: process.pid,
    socket: socketPath,
    configFile: options.configFile,
    ...extra,
  })

  // Reconciles are SERIALISED: two operators converging at once must not
  // interleave two deltas on the same tree.
  let inflight: Promise<unknown> = Promise.resolve()
  const serialise = <T>(run: () => Promise<T>): Promise<T> => {
    const next = inflight.then(run, run)
    inflight = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  const handle = async (line: string): Promise<ControlResponse> => {
    let request: ControlRequest
    try {
      request = JSON.parse(line) as ControlRequest
    } catch {
      return { ...answer('(invalid)'), ok: false, error: 'malformed request: expected one JSON object per line' }
    }
    const op = typeof request?.op === 'string' ? request.op : '(invalid)'
    try {
      if (op === 'ping') return answer(op)
      if (op === 'inventory') {
        const inventory = options.inventory()
        return answer(op, { inventory, plugins: inventory.plugins.length })
      }
      if (op === 'reconcile') {
        const report = await serialise(() => options.reconcile())
        return answer(op, { report, plugins: report.loaded })
      }
      if (op === 'sources-update') {
        const refresh = options.refreshSources
        if (refresh === undefined) {
          return { ...answer(op), ok: false, error: 'this process does not expose the sources-update operation' }
        }
        // Serialised with the reconciles: a source refresh and a roster converge
        // must never interleave two mutations of the same tree.
        const request2 = request
        const report = await serialise(() =>
          refresh({
            operation: request2.list === true ? 'list' : 'update',
            ...(Array.isArray(request2.ids) && request2.ids.length > 0 ? { ids: request2.ids } : {}),
          }),
        )
        return answer(op, { refresh: report, plugins: report.after.plugins.length })
      }
      return { ...answer(op), ok: false, error: `unknown op '${op}' (expected ping, inventory, reconcile or sources-update)` }
    } catch (error) {
      return { ...answer(op), ok: false, error: (error as Error).message }
    }
  }

  const server = net.createServer((socket) => {
    socket.setEncoding('utf8')
    let buffer = ''
    socket.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        if (line.length > 0) {
          void handle(line).then((response) => {
            if (!socket.destroyed) socket.end(JSON.stringify(response) + '\n')
          })
        }
        index = buffer.indexOf('\n')
      }
    })
    socket.on('error', () => undefined)
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, () => {
        server.off('error', reject)
        resolve()
      })
    })
  } catch (error) {
    server.close()
    options.log(`control: cannot serve ${socketPath} (${(error as Error).message}); continuing without a control channel`)
    return undefined
  }
  // The socket is a MUTATION channel of this process: owner only.
  try {
    fs.chmodSync(socketPath, 0o600)
  } catch {
    // A chmod failure must not disable the channel (a container may not allow it).
  }

  options.log(`control: out-of-band converge channel on ${socketPath} (pid ${process.pid})`)
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      try {
        fs.rmSync(socketPath, { force: true })
      } catch {
        // The socket file is gone with the process anyway.
      }
    },
  }
}

/** Sends ONE request and resolves with the answer line. */
export function callControlChannel(socketPath: string, request: ControlRequest, timeoutMs = 60_000): Promise<ControlResponse> {
  return new Promise<ControlResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buffer = ''
    let settled = false
    const timer = setTimeout(() => {
      finish(new Error(`the control channel ${socketPath} did not answer within ${timeoutMs} ms`))
    }, timeoutMs)
    const finish = (error?: Error, response?: ControlResponse): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error !== undefined) reject(error)
      else resolve(response as ControlResponse)
    }
    socket.setEncoding('utf8')
    socket.on('connect', () => socket.write(JSON.stringify(request) + '\n'))
    socket.on('data', (chunk: string) => {
      buffer += chunk
      const index = buffer.indexOf('\n')
      if (index < 0) return
      try {
        finish(undefined, JSON.parse(buffer.slice(0, index)) as ControlResponse)
      } catch {
        finish(new Error(`the control channel ${socketPath} answered with malformed JSON`))
      }
    })
    socket.on('error', (error) => finish(error))
    socket.on('close', () => finish(new Error(`the control channel ${socketPath} closed without an answer`)))
  })
}

/** The live channel behind `socketPath`, or `undefined` when nothing answers. */
export async function pingControlChannel(socketPath: string, timeoutMs = 500): Promise<ControlResponse | undefined> {
  if (!fs.existsSync(socketPath)) return undefined
  try {
    const response = await callControlChannel(socketPath, { op: 'ping' }, timeoutMs)
    return response.ok ? response : undefined
  } catch {
    return undefined
  }
}

/**
 * The converge operation driven OUT-OF-BAND against a RUNNING process:
 * `undefined` when no live channel owns `socketPath` (the caller then falls back
 * to its own one-shot converge).
 */
export async function reconcileViaControlChannel(socketPath: string, timeoutMs = 60_000): Promise<ControlResponse | undefined> {
  const live = await pingControlChannel(socketPath, 1_000)
  if (live === undefined) return undefined
  return callControlChannel(socketPath, { op: 'reconcile' }, timeoutMs)
}

/**
 * The SOURCE refresh driven OUT-OF-BAND against a RUNNING process:
 * `undefined` when no live channel owns `socketPath` (the caller then falls back
 * to its own one-shot refresh). The default timeout is generous on purpose: an
 * `update` fetches a repository AND may provision its dependencies.
 */
export async function refreshSourcesViaControlChannel(
  socketPath: string,
  request: { ids?: readonly string[]; list?: boolean } = {},
  timeoutMs = 600_000,
): Promise<ControlResponse | undefined> {
  const live = await pingControlChannel(socketPath, 1_000)
  if (live === undefined) return undefined
  return callControlChannel(
    socketPath,
    {
      op: 'sources-update',
      ...(request.ids === undefined || request.ids.length === 0 ? {} : { ids: [...request.ids] }),
      ...(request.list === true ? { list: true } : {}),
    },
    timeoutMs,
  )
}

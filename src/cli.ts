#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILES, findDefaultConfigFile } from './config.ts'
import { CREDENTIALS_CONTRACT, parseCredentialRef, refLabel } from './credentials/definition.ts'
import { createKernel, type Kernel } from './kernel.ts'
import { controlSocketPath, reconcileViaControlChannel, refreshSourcesViaControlChannel, startControlChannel } from './control.ts'
import type { WebSeam } from './web-seam.ts'
import type { HostReconcileReport, HostSourceRefreshReport, LoadedPlugin, PluginDiscoveryInfo, SourceRefreshEntry, SourceRefreshOperation } from './types.ts'

/**
 * The READ side of the `web@1` seam, declared structurally on purpose: the
 * Definition and the provider live in the EXTERNAL plugins repository
 * (`nexuslbs/workbench-plugins`), so the core never imports them.
 */
interface WebSeamRead extends WebSeam {
  pages(): { title: string; path: string; plugin: string }[]
  routes(): { method: string; path: string; description?: string }[]
  assets(): unknown[]
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Directory of the core package, the fallback location of the default config. */
const CORE_DIR = path.resolve(HERE, '..')

/**
 * Default bind port of the `web@1` PROVIDER PLUGIN (`web-impl`). The core keeps NO
 * listener of its own (operator rule 2026-09-19): it publishes the resolved port
 * into the environment (`WORKBENCH_PORT` / `WORKBENCH_WEB_PORT`) and the provider
 * plugin binds it; with no provider plugin loaded, nothing listens at all.
 */
export const WEB_PROVIDER_DEFAULT_PORT = 12348

/** Interval of the `serve` heartbeat log line. */
const HEARTBEAT_MS = 60_000

const HELP = `workbench - minimal cordis plugin host

Usage:
  workbench serve [--port <n>]    boot the plugins and keep running (service mode;
                                  EVERY listener - the Web UI AND /health - is
                                  bound by the web@1 provider plugin)
  workbench web [--port <n>]      boot the plugins, report the web state and keep
                                  running (the UI listener belongs to the plugin)
  workbench <command> [args...]   run a command registered by a plugin
  workbench plugins               list loaded plugins and their sources
  workbench reconcile [--local]   apply a config-file edit to the RUNNING process
                                  OUT-OF-BAND (no plugin, no HTTP route needed):
                                  like the boot it resolves the config (--config ->
                                  CONFIG_FILE -> default) and reaches the control
                                  socket of THAT process, which applies ONLY the
                                  delta of its desired plugins: roster (load /
                                  unload / reload / park); nothing is persisted,
                                  the config FILE is the input. With NO live
                                  process it converges a ONE-SHOT process instead
                                  (--local forces that and never touches a
                                  running one); --json prints the full per-plugin
                                  report; exit 1 when a row failed, the others
                                  still converged
  workbench sources list          list EVERY configured plugin source: id, kind,
                                  url, ref, checkout dir, resolved commit and the
                                  dependency state of the checkout (a 'path'
                                  source has no url/ref/commit - its directory,
                                  dependency state and plugins are reported).
                                  READS ONLY - no fetch, no install, no import.
                                  --id limits it to one source; --json prints the
                                  full report
  workbench sources update [--id <source-id>]
                                  UPDATE the plugin 'git' sources IN PLACE: for
                                  every selected source fetch + forced detached
                                  checkout of the ref the CONFIG declares,
                                  provision the checkout's dependencies, then
                                  RE-IMPORT the plugins whose code moved under
                                  the process - with NO config edit and NO
                                  restart. Like reconcile it reaches the RUNNING
                                  process over the control socket; --local runs a
                                  ONE-SHOT process instead. --id refreshes one
                                  source only; exit 1 when a source failed (the
                                  others still ran), 2 on a bad invocation
  workbench commands              list registered commands
  workbench tools                 list registered tools with their parameter schemas
                                  (a command of the TOOLS plugin - the core ships
                                  no tool module and no /api/tools route)
  workbench tool <name> ['<params-json>']
                                  invoke a tool by name through the same dispatch
                                  as POST /api/tools/<name> (validation errors are
                                  printed as violations; exit code 1 unknown tool,
                                  2 invalid params)
  workbench credentials providers list the credentials providers (enabled / registered)
  workbench credentials list      list the credential names the enabled providers answer
  workbench credentials resolve <NAME[|SCOPE/NAME]>
                                  resolve one credential through the credentials
                                  service (the VALUE is masked, never printed)
  workbench credentials explain <NAME[|SCOPE/NAME]>
                                  show which providers tried and which one answered

Options:
  --config <file>  config file to use; .json, .yml or .yaml (default: the first of
                   ${DEFAULT_CONFIG_FILES.join(', ')}
                   in the working directory, then next to the core)
  --port <n>       the port the web provider plugin binds; the core itself
                   binds NO port and exports the value as $WORKBENCH_PORT
                   (web: as $WORKBENCH_WEB_PORT). Plugin default:
                   $WORKBENCH_WEB_PORT / $WORKBENCH_PORT / the config, else
                   ${WEB_PROVIDER_DEFAULT_PORT}
  --host <h>       Web UI listener host read by the web provider plugin
                   (default: $WORKBENCH_WEB_HOST, the config, else 127.0.0.1)
  --web-port <n>   serve only: Web UI port when the config enables the UI;
                   set it to the status port (--port) to serve the UI AND
                   /health on ONE listener
  --id <source-id> 'workbench sources': limit list/update to ONE source (repeatable;
                   'update' covers 'git' sources only)
  --no-external    skip external plugin sources
  --json           machine readable output
  --help           this text

Environment:
  CONFIG_FILE      config file to use when --config is not given; empty/unset
                   falls back to the default config file lookup described above
  WORKBENCH_PORT   serve only: the port a web provider plugin binds (read by
                   THAT PLUGIN; the core binds no port, so with no provider
                   plugin loaded nothing listens)
  WORKBENCH_WEB_HOST / WORKBENCH_WEB_PORT
                   Web UI listener WHEN a web provider plugin (web-impl) is
                   loaded; the default host is 127.0.0.1 (loopback - the UI has
                   NO auth). The core itself hosts no web listener.
  WORKBENCH_CACHE_DIR  where git plugin sources are checked out
                   (default: <config dir>/.workbench/sources)
`

interface Flags {
  configFile?: string
  includeExternal: boolean
  /** `reconcile --local`: converge a ONE-SHOT process, never a running one. */
  local: boolean
  json: boolean
  port?: number
  /** `--host`: the Web UI listener host. */
  host?: string
  /** `--web-port`: the Web UI port when `serve` starts it (the status port keeps `--port`). */
  webPort?: number
  /** `--id`: `workbench sources`: the source ids to operate on (empty = every source). */
  id?: string[]
  rest: string[]
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { includeExternal: true, json: false, local: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') {
      const value = argv[++i]
      if (!value) throw new Error('--config needs a file path')
      flags.configFile = path.resolve(process.cwd(), value)
    }
    else if (arg === '--port') {
      const value = argv[++i]
      const port = Number(value)
      if (!value || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a port number (0-65535), got ${value ?? '(none)'}`)
      flags.port = port
    }
    else if (arg === '--host') {
      const value = argv[++i]
      if (!value) throw new Error('--host needs a host name or address')
      flags.host = value
    }
    else if (arg === '--web-port') {
      const value = argv[++i]
      const webPort = Number(value)
      if (!value || !Number.isInteger(webPort) || webPort < 0 || webPort > 65535) throw new Error(`--web-port needs a port number (0-65535), got ${value ?? '(none)'}`)
      flags.webPort = webPort
    }
    else if (arg === '--id') {
      const value = argv[++i]
      if (!value) throw new Error('--id needs a source id')
      ;(flags.id ??= []).push(value)
    }
    else if (arg === '--no-external') flags.includeExternal = false
    else if (arg === '--local') flags.local = true
    else if (arg === '--json') flags.json = true
    else flags.rest.push(arg)
  }
  return flags
}

/**
 * Config file resolution order: `--config` flag, then the `CONFIG_FILE`
 * environment variable (an empty value means "unset"), then the default config
 * file lookup in the working directory and next to the core.
 */
function resolveConfigFile(flags: Flags): string {
  if (flags.configFile) return flags.configFile
  const fromEnv = process.env.CONFIG_FILE?.trim()
  if (fromEnv) return path.resolve(fromEnv)
  return findDefaultConfigFile([...new Set([process.cwd(), CORE_DIR])])
}

/**
 * Ports are the WEB PROVIDER PLUGIN's business (the core binds no listener): the
 * CLI flags are published into the environment the provider plugin reads
 * (`WORKBENCH_PORT` / `WORKBENCH_WEB_PORT`), exactly like a deployment does. The
 * precedence among plugin row, these variables and the definition default lives
 * inside the plugin, so the core never resolves or binds a port.
 */
function publishPortEnv(flags: Flags): void {
  if (flags.port !== undefined) process.env.WORKBENCH_PORT = String(flags.port)
  if (flags.webPort !== undefined) process.env.WORKBENCH_WEB_PORT = String(flags.webPort)
}

function describePlugin(plugin: LoadedPlugin): string {
  const origin = plugin.external ? `external:${plugin.source}` : plugin.source
  const capabilities = plugin.capabilities.length ? plugin.capabilities.join(', ') : '-'
  return `${plugin.name}@${plugin.version}  ${origin}  [${capabilities}]`
}

function describeSource(source: Kernel['sources'][number]): string {
  return `source ${source.id} (${source.kind}, ${source.external ? 'external' : 'core'}): ${source.dir ?? 'unresolved'} [${source.plugins} plugin(s)]${source.error ? ` error=${source.error}` : ''}`
}

/**
 * One discovered plugin, as the INVENTORY reports it: the state is what tells
 * the operator whether the plugin is loaded, only AVAILABLE (discovered in a
 * source but not named in the `plugins:` roster), parked (`disabled`) or
 * failed.
 */
function describeDiscovery(entry: PluginDiscoveryInfo): string {
  const origin = entry.external ? `external:${entry.source}` : entry.source
  const capabilities = entry.capabilities.length ? entry.capabilities.join(', ') : '-'
  const error = entry.state === 'failed' && entry.error ? `  ${entry.error}` : ''
  const hint = entry.state === 'available' ? '  (available: add it to the plugins: roster - or enable it - to load it)' : ''
  return `${entry.name}@${entry.version}  ${origin}  [${capabilities}]  [${entry.state}]${error}${hint}`
}

function summaryLine(kernel: Kernel): string {
  const core = kernel.plugins.filter((plugin) => !plugin.external).length
  const inventory = kernel.host.inventory()
  return (
    `workbench: ${kernel.plugins.length} plugin(s) loaded (${core} core, ${kernel.plugins.length - core} external), ` +
    `${inventory.available.length} available (not on the plugins: roster), ${inventory.disabled.length} disabled, ${inventory.failures.length} failed`
  )
}

/** Credential VALUES are never printed: every output masks them. */
const MASKED = '****'

function credentialsLines(kernel: Kernel, json: boolean): string {
  // The CLI is a CONSUMER of the capability: it goes through the typed handle
  // `ctx.credentials` and never touches a provider module.
  const credentials = kernel.ctx.credentials
  const providers = credentials.providers()
  const enabled = credentials.enabled()
  if (json) {
    return JSON.stringify({ contract: CREDENTIALS_CONTRACT, enabled, providers }, null, 2)
  }
  const lines = [`credentials: ${providers.length} provider(s) declared, ${enabled.length} enabled (${CREDENTIALS_CONTRACT})`]
  for (const provider of providers) {
    const state = `${provider.enabled ? 'enabled' : 'disabled'}${provider.registered ? '' : ', not-registered'}`
    const origin = provider.external ? `external:${provider.source}` : provider.source
    lines.push(`  ${provider.id}  ${provider.contract}  [${state}]  declared by ${provider.plugin} (${origin})${provider.describe ? `  - ${provider.describe}` : ''}`)
  }
  lines.push(`resolution order: ${enabled.length ? enabled.join(' -> ') : '(none)'}`)
  return lines.join('\n')
}

/** `workbench credentials ...` - the non-config CONSUMER of the capability. */
async function credentialsCommand(kernel: Kernel, flags: Flags): Promise<void> {
  const [sub, ...rest] = flags.rest.slice(1)
  const credentials = kernel.ctx.credentials

  if (sub === undefined || sub === 'providers') {
    process.stdout.write(credentialsLines(kernel, flags.json) + '\n')
    return
  }

  if (sub === 'list') {
    const names = await credentials.list()
    if (flags.json) {
      process.stdout.write(JSON.stringify({ contract: CREDENTIALS_CONTRACT, enabled: credentials.enabled(), names }, null, 2) + '\n')
      return
    }
    process.stdout.write(names.length ? names.map((name) => `${name}\n`).join('') : 'no credential names available\n')
    return
  }

  if (sub === 'resolve' || sub === 'explain') {
    const spec = rest[0]
    if (!spec) throw new Error(`credentials ${sub}: needs a credential reference (NAME or SCOPE/NAME)`)
    const ref = parseCredentialRef(spec)
    if (sub === 'explain') {
      const trace = await credentials.explain(ref)
      if (flags.json) {
        process.stdout.write(JSON.stringify({ contract: CREDENTIALS_CONTRACT, ...trace }, null, 2) + '\n')
        return
      }
      process.stdout.write(`credential '${refLabel(ref)}': ${trace.resolvedBy ? `resolved by '${trace.resolvedBy}'` : 'not resolved'}\n`)
      for (const attempt of trace.attempts) {
        process.stdout.write(`  ${attempt.provider}: ${attempt.status}${attempt.error ? ` (${attempt.error})` : ''}\n`)
      }
      return
    }
    const resolution = await credentials.resolve(ref)
    if (!resolution) {
      process.stderr.write(
        `credential '${refLabel(ref)}' is not resolved by the enabled provider(s) ` +
          `${credentials.enabled().join(', ') || '(none)'}; check the name and the 'credentials' section of the config\n`,
      )
      process.exitCode = 1
      return
    }
    if (flags.json) {
      process.stdout.write(
        JSON.stringify({ contract: CREDENTIALS_CONTRACT, name: refLabel(ref), provider: resolution.provider, value: MASKED }, null, 2) + '\n',
      )
      return
    }
    process.stdout.write(
      `credential '${refLabel(ref)}' resolved by provider '${resolution.provider}' (${resolution.contract}): ${MASKED}\n`,
    )
    return
  }

  throw new Error(`unknown credentials subcommand '${sub}' (expected providers, list, resolve or explain)`)
}


/**
 * Long-running entrypoint used by the compose service: boots the plugins and
 * stays up until SIGINT/SIGTERM. The CORE HOLDS NO LISTENER (operator rule
 * 2026-09-19): every HTTP surface - `/health` included - is bound by the `web@1`
 * PROVIDER PLUGIN the config loads, so this function reports the observed state
 * and keeps the process alive instead of binding anything. Keeping the process
 * alive is the whole point - a container that only sleeps would report `Up`
 * while hosting nothing.
 *
 * `kernel.webState` says what this deployment got:
 *   served   -> a provider plugin is loaded and owns the port; it answers
 *               /health from the same live inventory;
 *   deferred -> the config asks for the web UI but no provider plugin is
 *               loaded: structured deferral (loud log line + the `web` state in
 *               the inventory), no crash, no silent skip, NO port bound;
 *   off      -> nothing was asked for, no port bound.
 */
async function serve(kernel: Kernel): Promise<void> {
  const webState = kernel.webState
  // THE BOOT BANNER - the ONE documented exception to "the core prints nothing
  // outside the service path" (task R1/2): this report IS the answer of the
  // service-mode command (the same inventory `workbench plugins` prints), it is
  // emitted ONCE at boot and it is not a log stream. Everything periodic or
  // event-driven (the heartbeat, the shutdown line, the control channel) goes
  // through the logger SERVICE instead, where a LOG line is rendered by whichever
  // EXPORTER PLUGIN is mounted and is silent when none is. The banner is what
  // lets an operator see the state a deployment booted with.
  if (webState.state === 'served') {
    process.stdout.write(
      `workbench: web served by plugin '${webState.plugin}' (provider '${webState.provider}', ` +
        `${webState.external ? 'external:' : ''}${webState.source}); this process binds no port of its own\n`,
    )
  } else if (webState.state === 'deferred') {
    process.stdout.write(`workbench: web is DEFERRED - ${webState.reason}\n`)
  } else {
    process.stdout.write('workbench: web state=off - no web@1 provider plugin is loaded and this process binds no port\n')
  }
  process.stdout.write(summaryLine(kernel) + '\n')
  for (const source of kernel.sources) process.stdout.write(describeSource(source) + '\n')
  for (const plugin of kernel.plugins) process.stdout.write(`  ${describePlugin(plugin)}\n`)
  process.stdout.write(credentialsLines(kernel, false) + '\n')
  for (const failure of kernel.failures) process.stdout.write(`  failed ${failure.plugin} (${failure.source}): ${failure.error}\n`)

  // The heartbeat is a LOG line, not CLI output: it goes through the logger
  // service of this process (`ctx.logger('workbench')`), so an exporter plugin
  // renders it and a deployment with no exporter plugin mounted is silent.
  //
  // The interval is deliberately NOT unref'd: with no `web@1` provider plugin
  // the core binds NO socket, so this interval is the one handle that keeps the
  // process (and the loaded plugins) alive until SIGINT/SIGTERM. Unref'ing it
  // made `serve` exit right after boot once the core stopped owning a listener.
  const heartbeat = setInterval(() => {
    kernel.ctx.logger('workbench').info(`alive (pid ${process.pid}, uptime ${Math.round(process.uptime())}s, ${kernel.plugins.length} plugin(s))`)
  }, HEARTBEAT_MS)

  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      kernel.ctx.logger('workbench').info(`${signal} received, shutting down`)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  clearInterval(heartbeat)
}

/**
 * Long-running Web UI entrypoint (`workbench web`): boots the kernel and stays up
 * until SIGINT/SIGTERM. The UI itself - the listener, the shell, every page,
 * route and asset - comes from the `web@1` PROVIDER PLUGIN the config loads; the
 * core reports the state and hosts nothing. With no provider plugin loaded the
 * deferral is reported (no crash, no silent skip) and the process keeps serving.
 */
async function web(kernel: Kernel, flags: Flags): Promise<void> {
  const state = kernel.webState
  const origin = state.plugin ? ` plugin=${state.plugin} (provider ${state.provider}, ${state.external ? 'external:' : ''}${state.source})` : ''
  process.stdout.write(`workbench: web state=${state.state}${origin} config=${kernel.configFile}\n`)
  if (state.state === 'deferred') process.stdout.write(`workbench: web is DEFERRED - ${state.reason}\n`)
  process.stdout.write(summaryLine(kernel) + '\n')
  const seam = (kernel.ctx as unknown as { web?: WebSeamRead }).web
  if (seam) {
    const pages = seam.pages()
    process.stdout.write(
      pages.length
        ? `pages: ${pages.map((page) => `${page.title} ${page.path} (${page.plugin})`).join(', ')}\n`
        : 'pages: none - no UI plugin is configured, the empty shell is served\n',
    )
    process.stdout.write(`seam: ${pages.length} page(s), ${seam.routes().length} route(s), ${seam.assets().length} asset(s)\n`)
  } else {
    process.stdout.write('seam: not provided - no web@1 provider plugin is loaded\n')
  }
  await serve(kernel)
}

/**
 * Serves the OUT-OF-BAND control channel of a long-running process for as long
 * as it runs (see `control.ts`): a deployment can end up with a MINIMAL roster
 * that loaded NO management plugin, and then the in-process mutation surface
 * simply does not exist - there is no route to call. The channel keeps
 * `host.reconcile()` reachable on such a process (no plugin, no HTTP route, no
 * extra port), so a config edit is applied by `workbench reconcile` against the
 * RUNNING process instead of a restart.
 */
async function withControlChannel(kernel: Kernel, body: () => Promise<void>): Promise<void> {
  const control = await startControlChannel({
    socketPath: controlSocketPath(kernel.configFile),
    configFile: kernel.configFile,
    inventory: () => kernel.host.inventory(),
    reconcile: async () => {
      const report = await kernel.host.reconcile()
      // A converge can load (or unload) the `web@1` PROVIDER plugin: the core's
      // own routes belong to that seam INSTANCE, and a process that booted a
      // minimal roster had none to register on. Without this the converged
      // deployment answers the plugin's routes and 404s `/api/plugins`.
      kernel.refreshCoreRoutes()
      return report
    },
    // The source refresh rides the SAME channel: a process that booted a
    // MINIMAL roster (no management plugin, no HTTP route, no extra port) can
    // still be told to update its plugin sources in place, exactly like it can
    // be told to converge its roster.
    refreshSources: async (options) => {
      const report = await kernel.host.refreshSources(options)
      // The refresh can re-import a plugin that owns this process's own routes
      // (the `web@1` provider): re-attach them to the live seam.
      kernel.refreshCoreRoutes()
      return report
    },
    // The channel's diagnostics are LOG lines like any other: they go through
    // the logger service of THIS process (rendered by whichever exporter plugin
    // is mounted), not straight to stdout. This is also the proof that the
    // service is reachable from the CLI context: `kernel.ctx` is the context the
    // CLI boots, so a CLI-side message has the same named/levelled path as a
    // plugin's.
    log: (message) => kernel.ctx.logger('control').info(message),
  })
  try {
    await body()
  } finally {
    await control?.close()
  }
}

/**
 * Renders ONE `host.reconcile()` report. The SAME rendering serves the converge
 * this process performed itself and the one a RUNNING process reported back over
 * its control channel - a caller must not be able to tell them apart.
 */
function printReconcileReport(report: HostReconcileReport, json: boolean, header?: string): void {
  if (header !== undefined) process.stdout.write(header + '\n')
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  process.stdout.write(report.message + '\n')
  for (const change of report.changes) {
    process.stdout.write(
      `  ${change.name}: ${change.action}${change.desired ? '' : ' (no longer desired)'} - ${change.reason}` +
        `${change.error === undefined ? '' : `: ${change.error}`}\n`,
    )
  }
  process.stdout.write(
    `  ok=${report.ok} loaded=${report.loaded} deferred=${report.deferred.length ? report.deferred.join(', ') : 'none'} ` +
      `errors=${report.errors.length ? report.errors.join(', ') : 'none'}\n`,
  )
}

/**
 * Renders ONE `host.refreshSources()` report. The SAME rendering serves the
 * refresh this process performed itself and the one a RUNNING process reported
 * back over its control channel - a caller must not be able to tell them apart.
 */
function printSourceRefreshReport(report: HostSourceRefreshReport, json: boolean, header?: string): void {
  if (header !== undefined) process.stdout.write(header + '\n')
  if (json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n')
    return
  }
  process.stdout.write(report.message + '\n')
  for (const source of report.sources) {
    const move = source.changed
      ? `${shortenCommit(source.previousCommit)} -> ${shortenCommit(source.resolvedCommit)} CHANGED`
      : `unchanged at ${shortenCommit(source.resolvedCommit)}`
    process.stdout.write(`  ${source.id} (${sourceOrigin(source)}): ${move}\n`)
    process.stdout.write(`    dir: ${source.dir ?? '(unresolved)'}  deps: ${dependencyLine(source)}\n`)
    if (source.plugins.length) process.stdout.write(`    plugins: ${source.plugins.join(', ')}\n`)
    if (source.reimported.length) process.stdout.write(`    re-imported: ${source.reimported.join(', ')}\n`)
    if (source.error !== undefined) process.stdout.write(`    error: ${source.error}\n`)
  }
  process.stdout.write(
    `  ok=${report.ok} persisted=false operation=${report.operation} ` +
      `changed=${report.changed.length ? report.changed.join(', ') : 'none'} ` +
      `re-imported=${report.reimported.length ? report.reimported.join(', ') : 'none'} ` +
      `errors=${report.errors.length ? report.errors.join(', ') : 'none'}\n`,
  )
}

/** The coordinates of a source as one line: kind, url, configured ref. */
function sourceOrigin(source: SourceRefreshEntry): string {
  const parts = [source.kind]
  if (source.url !== null) parts.push(source.url)
  if (source.ref !== null) parts.push(`ref ${source.ref}`)
  return parts.join(', ')
}

/**
 * The dependency line of one source: the OUTCOME of this refresh when it ran
 * (`provisioned` / `cached` / `skipped` / `failed`, with the exact command), else
 * the state READ FROM DISK (`provisioned` / `stale` / `missing` / `none`).
 */
function dependencyLine(source: SourceRefreshEntry): string {
  const dependency = source.dependencies
  if (dependency === undefined) return source.dependency
  const detail = dependency.error === undefined ? '' : `: ${dependency.error}`
  return `${dependency.status} (${dependency.command})${detail}`
}

/** A commit as an operator reads it: the short form, never a truncated word. */
function shortenCommit(commit: string | null): string {
  if (commit === null || commit.length === 0) return '(none)'
  return commit.slice(0, 12)
}

/**
 * The `workbench sources` subcommand of `flags.rest`: `update` or `list`, plus
 * the `--id` selection. A missing/unknown verb is a USAGE error (exit 2), never
 * a silent `update` of every source.
 */
function parseSourcesRequest(flags: Flags): { operation: SourceRefreshOperation; ids?: string[] } {
  const sub = flags.rest[1]
  if (sub !== 'update' && sub !== 'list') {
    throw new Error(
      `sources: expected 'update' or 'list', got '${sub ?? '(none)'}' ` +
        `(usage: workbench sources update|list [--id <source-id>] [--json] [--local])`,
    )
  }
  return { operation: sub, ...(flags.id === undefined || flags.id.length === 0 ? {} : { ids: flags.id }) }
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  const [head] = flags.rest
  // The core binds NO port: `--port` / `--web-port` belong to the web provider
  // plugin, so they are exported into the environment it reads - the same way a
  // deployment sets WORKBENCH_PORT.
  publishPortEnv(flags)
  if (!head || head === 'help' || head === '--help') {
    process.stdout.write(HELP)
    return
  }

  // `reconcile` is the OUT-OF-BAND converge: it reaches the RUNNING process that
  // owns THIS config (the same resolution as the boot: --config -> CONFIG_FILE ->
  // default) through the control channel that process serves, and only falls back
  // to a one-shot process of its own when nothing answers. That is the recovery
  // path of a deployment whose roster loaded NO management plugin at all: there
  // is no HTTP action to call, and this needs none - no plugin, no route, no
  // extra port (`--local` skips the running process entirely).
  if (head === 'reconcile' && !flags.local) {
    const configFile = resolveConfigFile(flags)
    const socket = controlSocketPath(configFile)
    const answer = await reconcileViaControlChannel(socket)
    if (answer?.report !== undefined) {
      printReconcileReport(
        answer.report,
        flags.json,
        `workbench: the RUNNING process (pid ${answer.pid}) applied the config change out-of-band via ${socket}`,
      )
      process.exitCode = answer.report.ok ? 0 : 1
      return
    }
    if (answer !== undefined) {
      process.stderr.write(
        `workbench: the control channel ${socket} (pid ${answer.pid}) did not converge: ${answer.error ?? 'unknown error'}\n`,
      )
      process.exitCode = 1
      return
    }
    process.stderr.write(
      `workbench: no live workbench process serves the control channel ${socket} for ${configFile}; ` +
        `converging a ONE-SHOT process instead - a running process, if any, is NOT changed\n`,
    )
  }

  // `sources` is the EXPLICIT source refresh: the SAME out-of-band reachability
  // as `reconcile` - the control socket of the process that owns THIS config, no
  // plugin, no HTTP route, no extra port - but it refreshes the SOURCE CHECKOUTS
  // instead of the roster: fetch + forced detached checkout of the ref the
  // CONFIG declares, dependency provisioning of the checkout, and the re-import
  // of the plugins whose code moved, all IN PLACE. Nothing is persisted (the
  // config file is the input and stays the source of truth) and a running
  // process is never restarted; `--local` skips the running process entirely.
  if (head === 'sources') {
    let request: { operation: SourceRefreshOperation; ids?: string[] }
    try {
      request = parseSourcesRequest(flags)
    } catch (error) {
      process.stderr.write(`workbench: ${(error as Error).message}\n`)
      process.exitCode = 2
      return
    }
    if (!flags.local) {
      const configFile = resolveConfigFile(flags)
      const socket = controlSocketPath(configFile)
      const answer = await refreshSourcesViaControlChannel(socket, {
        ...(request.ids === undefined ? {} : { ids: request.ids }),
        list: request.operation === 'list',
      })
      if (answer?.refresh !== undefined) {
        printSourceRefreshReport(
          answer.refresh,
          flags.json,
          `workbench: the RUNNING process (pid ${answer.pid}) refreshed the plugin sources out-of-band via ${socket}`,
        )
        process.exitCode = answer.refresh.ok ? 0 : 1
        return
      }
      if (answer !== undefined) {
        process.stderr.write(
          `workbench: the control channel ${socket} (pid ${answer.pid}) did not refresh the sources: ${answer.error ?? 'unknown error'}\n`,
        )
        process.exitCode = 1
        return
      }
      process.stderr.write(
        `workbench: no live workbench process serves the control channel ${socket} for ${configFile}; ` +
          `refreshing the sources with a ONE-SHOT process instead - a running process, if any, is NOT changed\n`,
      )
    }
  }

  if (head === 'serve') {
    const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
    try {
      await withControlChannel(kernel, () => serve(kernel))
    } finally {
      await kernel.dispose()
    }
    return
  }

  if (head === 'web') {
    const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
    try {
      await withControlChannel(kernel, () => web(kernel, flags))
    } finally {
      await kernel.dispose()
    }
    return
  }

  const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
  try {
    if (head === 'plugins') {
      const inventory = kernel.host.inventory()
      if (flags.json) {
        process.stdout.write(JSON.stringify({ ...inventory, configFile: kernel.configFile }, null, 2) + '\n')
        return
      }
      process.stdout.write(summaryLine(kernel) + '\n')
      const surface = inventory.mutationSurface
      process.stdout.write(
        `  mutation surface: ${surface.loaded ? `in-process (${surface.providers.join(', ')})` : 'NONE - no loaded plugin declares a management page/route'}` +
          `${surface.candidates.length ? `; candidates on the roster away: ${surface.candidates.join(', ')}` : ''}\n`,
      )
      if (!surface.loaded) {
        process.stdout.write(`  remedy: ${surface.remedy}\n`)
        process.stdout.write(`  out-of-band: workbench reconcile   (control socket ${surface.controlSocket})\n`)
      }
      for (const source of kernel.sources) process.stdout.write(describeSource(source) + '\n')
      for (const entry of inventory.discovered) process.stdout.write(`  ${describeDiscovery(entry)}\n`)
      return
    }

    if (head === 'reconcile') {
      // No live channel answered (or `--local` was given): converge THIS one-shot
      // process with the SAME operation the running process uses.
      const report = await kernel.host.reconcile()
      printReconcileReport(report, flags.json)
      // A row that failed leaves the process running: the exit code is what tells
      // a script that the roster did NOT fully converge.
      process.exitCode = report.ok ? 0 : 1
      return
    }

    if (head === 'sources') {
      // No live channel answered (or `--local` was given): refresh THIS one-shot
      // process with the SAME operation the running process uses. `list` only
      // reads the state, so a one-shot `list` never touches a checkout.
      const report = await kernel.host.refreshSources(parseSourcesRequest(flags))
      printSourceRefreshReport(report, flags.json)
      process.exitCode = report.ok ? 0 : 1
      return
    }

    if (head === 'commands') {
      const commands = kernel.registry.commands()
      if (flags.json) {
        process.stdout.write(JSON.stringify(commands.map(({ name, description, plugin }) => ({ name, description, plugin })), null, 2) + '\n')
        return
      }
      if (!commands.length) process.stdout.write('no commands registered\n')
      for (const command of commands.sort((a, b) => a.name.localeCompare(b.name))) {
        process.stdout.write(`${command.name}${command.description ? `  ${command.description}` : ''}${command.plugin ? `  [${command.plugin}]` : ''}\n`)
      }
      return
    }

    // `workbench tools` / `workbench tool <name>` are NOT core commands any
    // more: the whole tools capability lives in the PUBLIC
    // nexuslbs/workbench-plugins repo, whose `tools-impl` plugin registers these
    // two commands through the command registry. With that plugin loaded they
    // work exactly as before; without it they are simply not registered.

    if (head === 'credentials') {
      await credentialsCommand(kernel, flags)
      return
    }


    const resolved = kernel.registry.resolve(flags.rest)
    if (!resolved) {
      process.stderr.write(`unknown command: ${flags.rest.join(' ')}\n`)
      const available = kernel.registry.commands().map((command) => command.name).sort()
      process.stderr.write(`available commands: ${available.length ? available.join(', ') : '(none)'}\n`)
      process.exitCode = 1
      return
    }
    const output = await resolved.command.run(resolved.args)
    if (typeof output === 'string' && output.length > 0) process.stdout.write(output + '\n')
  } finally {
    await kernel.dispose()
  }
}

await main()

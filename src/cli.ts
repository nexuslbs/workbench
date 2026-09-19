#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILES, findDefaultConfigFile } from './config.ts'
import { CREDENTIALS_CONTRACT, parseCredentialRef, refLabel } from './credentials/definition.ts'
import { createKernel, type Kernel } from './kernel.ts'
import type { WebSeam } from './web-seam.ts'
import type { LoadedPlugin, PluginDiscoveryInfo } from './types.ts'

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
  workbench reconcile             apply a config-file edit to the RUNNING process:
                                  diff the desired plugins: roster against the
                                  loaded set and apply ONLY the delta (load /
                                  unload / reload / park); nothing is persisted,
                                  the config FILE is the input (--json for the
                                  full per-plugin report; exit 1 when a row
                                  failed, the others still converged)
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
  json: boolean
  port?: number
  /** `--host`: the Web UI listener host. */
  host?: string
  /** `--web-port`: the Web UI port when `serve` starts it (the status port keeps `--port`). */
  webPort?: number
  rest: string[]
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { includeExternal: true, json: false, rest: [] }
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
    else if (arg === '--no-external') flags.includeExternal = false
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

  // The heartbeat is deliberately NOT unref'd: with no `web@1` provider plugin
  // the core binds NO socket, so this interval is the one handle that keeps the
  // process (and the loaded plugins) alive until SIGINT/SIGTERM. Unref'ing it
  // made `serve` exit right after boot once the core stopped owning a listener.
  const heartbeat = setInterval(() => {
    process.stdout.write(`workbench: alive (pid ${process.pid}, uptime ${Math.round(process.uptime())}s, ${kernel.plugins.length} plugin(s))\n`)
  }, HEARTBEAT_MS)

  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      process.stdout.write(`workbench: ${signal} received, shutting down\n`)
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

  if (head === 'serve') {
    const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
    try {
      await serve(kernel)
    } finally {
      await kernel.dispose()
    }
    return
  }

  if (head === 'web') {
    const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
    try {
      await web(kernel, flags)
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
      for (const source of kernel.sources) process.stdout.write(describeSource(source) + '\n')
      for (const entry of inventory.discovered) process.stdout.write(`  ${describeDiscovery(entry)}\n`)
      return
    }

    if (head === 'reconcile') {
      const report = await kernel.host.reconcile()
      if (flags.json) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n')
      } else {
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
      // A row that failed leaves the process running: the exit code is what tells
      // a script that the roster did NOT fully converge.
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

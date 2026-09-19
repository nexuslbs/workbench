#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILES, findDefaultConfigFile } from './config.ts'
import { CREDENTIALS_CONTRACT, parseCredentialRef, refLabel } from './credentials/definition.ts'
import { EMAIL_CONTRACT } from './email/definition.ts'
import { createKernel, type Kernel } from './kernel.ts'
import { TOOLS_CONTRACT, ToolArgsError, ToolUnknownError } from './tools/definition.ts'
import type { LoadedPlugin, PluginDiscoveryInfo } from './types.ts'
import { DEFAULT_WEB_HOST, DEFAULT_WEB_PORT, type WebHandler } from './web/definition.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Directory of the core package, the fallback location of the default config. */
const CORE_DIR = path.resolve(HERE, '..')

/** Default port of the `serve` status endpoint (published by the dev overlay). */
export const DEFAULT_PORT = 12347

/** Interval of the `serve` heartbeat log line. */
const HEARTBEAT_MS = 60_000

const HELP = `workbench - minimal cordis plugin host

Usage:
  workbench serve [--port <n>]    boot the plugins and keep running (service mode;
                                  also serves the Web UI when the config enables it)
  workbench web [--host <h>] [--port <n>]
                                  serve the browser UI and keep running
  workbench <command> [args...]   run a command registered by a plugin
  workbench plugins               list loaded plugins and their sources
  workbench commands              list registered commands
  workbench tools                 list registered tools with their parameter schemas
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
  workbench email providers       list the email providers (enabled / registered)
  workbench email accounts        list the configured mail accounts (label/address,
                                  never a value) of the answering provider

Options:
  --config <file>  config file to use; .json, .yml or .yaml (default: the first of
                   ${DEFAULT_CONFIG_FILES.join(', ')}
                   in the working directory, then next to the core)
  --port <n>       serve: status endpoint port (default: $WORKBENCH_PORT or ${DEFAULT_PORT});
                   web: Web UI port (default: $WORKBENCH_WEB_PORT, the config, else ${DEFAULT_WEB_PORT})
  --host <h>       Web UI listener host (default: $WORKBENCH_WEB_HOST, the config, else ${DEFAULT_WEB_HOST})
  --web-port <n>   serve only: Web UI port when the config enables the UI;
                   set it to the status port (--port) to serve the UI AND
                   /health on ONE listener
  --no-external    skip external plugin sources
  --json           machine readable output
  --help           this text

Environment:
  CONFIG_FILE      config file to use when --config is not given; empty/unset
                   falls back to the default config file lookup described above
  WORKBENCH_PORT   serve only: status endpoint port (default: ${DEFAULT_PORT})
  WORKBENCH_WEB_HOST / WORKBENCH_WEB_PORT
                   Web UI listener when the config enables it; the default host is
                   ${DEFAULT_WEB_HOST} (loopback - the UI has NO auth)
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

/** Serve port resolution order: `--port` flag, `WORKBENCH_PORT`, then the default. */
function resolvePort(flags: Flags): number {
  if (flags.port !== undefined) return flags.port
  const fromEnv = process.env.WORKBENCH_PORT?.trim()
  if (fromEnv) {
    const port = Number(fromEnv)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`WORKBENCH_PORT must be a port number (0-65535), got '${fromEnv}'`)
    return port
  }
  return DEFAULT_PORT
}

/**
 * Web host resolution order: `--host`, `WORKBENCH_WEB_HOST`, the config, then
 * the loopback default. The default is deliberate: this round has no auth, so
 * exposing the UI to another machine must be an explicit act.
 */
function resolveWebHost(explicit: string | undefined, fromConfig: string | undefined): string {
  return explicit ?? process.env.WORKBENCH_WEB_HOST?.trim() ?? fromConfig?.trim() ?? DEFAULT_WEB_HOST
}

/** Web port resolution order: `--port`/`--web-port`, `WORKBENCH_WEB_PORT`, the config, then the default. */
function resolveWebPort(explicit: number | undefined, fromConfig: number | undefined): number {
  if (explicit !== undefined) return explicit
  const fromEnv = process.env.WORKBENCH_WEB_PORT?.trim()
  if (fromEnv) {
    const port = Number(fromEnv)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`WORKBENCH_WEB_PORT must be a port number (0-65535), got '${fromEnv}'`)
    return port
  }
  return fromConfig ?? DEFAULT_WEB_PORT
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

/** `workbench email ...` - the non-config CONSUMER of the capability. */
async function emailCommand(kernel: Kernel, flags: Flags): Promise<void> {
  const [sub] = flags.rest.slice(1)
  const email = kernel.ctx.email

  if (sub === undefined || sub === 'providers') {
    const providers = email.providers()
    const enabled = email.enabled()
    if (flags.json) {
      process.stdout.write(JSON.stringify({ contract: EMAIL_CONTRACT, enabled, providers }, null, 2) + '\n')
      return
    }
    const lines = [`email: ${providers.length} provider(s) declared, ${enabled.length} enabled (${EMAIL_CONTRACT})`]
    for (const provider of providers) {
      const state = `${provider.enabled ? 'enabled' : 'disabled'}${provider.registered ? '' : ', not-registered'}`
      const origin = provider.external ? `external:${provider.source}` : provider.source
      lines.push(
        `  ${provider.id}  ${provider.contract}  [${state}]  declared by ${provider.plugin} (${origin})` +
          `${provider.describe ? `  - ${provider.describe}` : ''}`,
      )
    }
    lines.push(`selection order: ${enabled.length ? enabled.join(' -> ') : '(none)'}`)
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  if (sub === 'accounts') {
    const accounts = await email.accounts()
    if (flags.json) {
      process.stdout.write(JSON.stringify({ contract: EMAIL_CONTRACT, enabled: email.enabled(), accounts }, null, 2) + '\n')
      return
    }
    if (accounts.length === 0) {
      process.stdout.write('email: no configured account (the enabled provider is registered but not configured)\n')
      return
    }
    const lines = [`email: ${accounts.length} account(s) (${EMAIL_CONTRACT})`]
    for (const account of accounts) {
      lines.push(
        `  ${account.label}${account.address ? `  ${account.address}` : ''}${account.default ? '  [default]' : ''}` +
          `${account.description ? `  - ${account.description}` : ''}`,
      )
    }
    process.stdout.write(lines.join('\n') + '\n')
    return
  }

  throw new Error(`unknown email subcommand '${sub}' (expected providers or accounts)`)
}

/**
 * Long-running entrypoint used by the compose service: boots the kernel, serves
 * a tiny status endpoint (`GET /health` -> the loaded plugins and sources) and
 * stays up until SIGINT/SIGTERM. Keeping the process alive is the whole point -
 * a container that only sleeps would report `Up` while hosting nothing.
 */
async function serve(kernel: Kernel, flags: Flags, port: number): Promise<void> {
  // The Web UI attaches to THIS process: `serve` is the single long-running
  // entrypoint of the service, so when the config enables the UI the core web
  // provider starts here too. When the configured WEB port IS the status port
  // both live on ONE listener: the provider serves the UI and hands the status
  // path to the fallback below, so the published port carries the browser UI and
  // the healthcheck together. Different ports keep the two-listener setup.
  const webConfig = kernel.config.web ?? {}
  const webEnabled = webConfig.enabled === true
  const webPort = webEnabled ? resolveWebPort(flags.webPort, webConfig.port) : undefined
  const merged = webEnabled && webPort === port
  const status = (): string =>
    JSON.stringify(
      {
        status: 'ok',
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        configFile: kernel.configFile,
        plugins: kernel.plugins,
        sources: kernel.sources,
        failures: kernel.failures,
      },
      null,
      2,
    )

  /** The status endpoint, riding the UI listener when the two share a port. */
  const statusFallback: WebHandler = (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') return undefined
    if (request.path !== '/health' && request.path !== '/healthz') return undefined
    return { contentType: 'application/json; charset=utf-8', body: status() + '\n' }
  }

  let webServer: Awaited<ReturnType<Kernel['startWeb']>> | undefined
  if (webEnabled) {
    webServer = await kernel.startWeb({
      host: resolveWebHost(flags.host, webConfig.host),
      port: webPort,
      ...(merged ? { fallback: statusFallback } : {}),
    })
    process.stdout.write(
      merged
        ? `workbench: web UI on ${webServer.url} (web.enabled; one listener with the status endpoint, /health answers there too)\n`
        : `workbench: web UI on ${webServer.url} (web.enabled in the config)\n`,
    )
  }

  /** The plain status listener: the JSON status on `/health`, `/` and `/?...`. */
  const handleStatus = (request: http.IncomingMessage, response: http.ServerResponse): void => {
    const url = request.url ?? '/'
    if (url === '/health' || url === '/' || url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(status() + '\n')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'not found', path: url }) + '\n')
  }

  // Merged: the UI listener owns the port and the status endpoint rides on it
  // (through the fallback). Not merged: the status listener is alone on it.
  const server = merged ? undefined : http.createServer(handleStatus)

  if (server) {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '0.0.0.0', resolve)
    })
    process.stdout.write(`workbench: serving on http://0.0.0.0:${port} config=${kernel.configFile}\n`)
  }
  process.stdout.write(summaryLine(kernel) + '\n')
  for (const source of kernel.sources) process.stdout.write(describeSource(source) + '\n')
  for (const plugin of kernel.plugins) process.stdout.write(`  ${describePlugin(plugin)}\n`)
  process.stdout.write(credentialsLines(kernel, false) + '\n')
  for (const failure of kernel.failures) process.stdout.write(`  failed ${failure.plugin} (${failure.source}): ${failure.error}\n`)

  const heartbeat = setInterval(() => {
    process.stdout.write(`workbench: alive (pid ${process.pid}, uptime ${Math.round(process.uptime())}s, ${kernel.plugins.length} plugin(s))\n`)
  }, HEARTBEAT_MS)
  heartbeat.unref()

  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      process.stdout.write(`workbench: ${signal} received, shutting down\n`)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  clearInterval(heartbeat)
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  if (webServer) await webServer.close()
}

/**
 * Long-running Web UI entrypoint (`workbench web`): boots the kernel, starts the
 * core web provider (the seam) and stays up until SIGINT/SIGTERM. The UI itself
 * is built by the plugins the config loads - with none, the empty shell is
 * served, which is what makes "UI is composed ONLY of plugins" checkable.
 * The core adds NO product feature here: it serves bytes and routes them.
 */
async function web(kernel: Kernel, flags: Flags): Promise<void> {
  const webConfig = kernel.config.web ?? {}
  const server = await kernel.startWeb({
    host: resolveWebHost(flags.host, webConfig.host),
    port: resolveWebPort(flags.port ?? flags.webPort, webConfig.port),
  })
  process.stdout.write(`workbench: web UI on ${server.url} config=${kernel.configFile}\n`)
  process.stdout.write(summaryLine(kernel) + '\n')
  const pages = kernel.web.pages()
  process.stdout.write(
    pages.length
      ? `pages: ${pages.map((page) => `${page.title} ${page.path} (${page.plugin})`).join(', ')}\n`
      : 'pages: none - no UI plugin is configured, the empty shell is served\n',
  )
  process.stdout.write(`seam: ${pages.length} page(s), ${kernel.web.routes().length} route(s), ${kernel.web.assets().length} asset(s)\n`)
  await new Promise<void>((resolve) => {
    const stop = (signal: NodeJS.Signals): void => {
      process.stdout.write(`workbench: ${signal} received, shutting down\n`)
      resolve()
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  await server.close()
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  const [head] = flags.rest
  if (!head || head === 'help' || head === '--help') {
    process.stdout.write(HELP)
    return
  }

  if (head === 'serve') {
    const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
    try {
      await serve(kernel, flags, resolvePort(flags))
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

    if (head === 'tools') {
      const tools = kernel.registry.tools()
      if (flags.json) {
        process.stdout.write(JSON.stringify({ contract: TOOLS_CONTRACT, tools }, null, 2) + '\n')
        return
      }
      if (!tools.length) process.stdout.write('no tools registered\n')
      for (const tool of tools) {
        process.stdout.write(`${tool.name}${tool.description ? `  ${tool.description}` : ''}  [${tool.plugin}]\n`)
        const required = new Set(tool.parameters?.required ?? [])
        for (const [name, property] of Object.entries(tool.parameters?.properties ?? {})) {
          const description = property.description ? `  ${property.description}` : ''
          process.stdout.write(`    ${name}${required.has(name) ? ' (required)' : ''}: ${property.type}${description}\n`)
        }
      }
      return
    }

    if (head === 'tool') {
      const [, name, ...rest] = flags.rest
      if (!name) throw new Error('tool: needs a tool name (workbench tool <name> [<params-json>])')
      const raw = rest.join(' ').trim()
      let params: unknown = {}
      if (raw.length > 0) {
        try {
          params = JSON.parse(raw) as unknown
        } catch (error) {
          throw new Error(`tool ${name}: the parameters must be valid JSON (${error instanceof Error ? error.message : String(error)})`)
        }
      }
      // THE dispatch: the CLI runs the very call the HTTP routes run (resolve,
      // validate, then the handler), so the two surfaces cannot drift.
      try {
        const result = await kernel.registry.executeTool(name, params)
        process.stdout.write(JSON.stringify({ status: 'ok', tool: name, result }, null, 2) + '\n')
      } catch (error) {
        if (error instanceof ToolArgsError) {
          process.stderr.write(`${error.message}\n`)
          for (const violation of error.violations) process.stderr.write(`  - ${violation}\n`)
          process.exitCode = 2
          return
        }
        if (error instanceof ToolUnknownError) {
          process.stderr.write(`${error.message}\n`)
          process.exitCode = 1
          return
        }
        throw error
      }
      return
    }

    if (head === 'credentials') {
      await credentialsCommand(kernel, flags)
      return
    }

    if (head === 'email') {
      await emailCommand(kernel, flags)
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

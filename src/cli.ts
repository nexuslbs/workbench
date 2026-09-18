#!/usr/bin/env node
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILES, findDefaultConfigFile } from './config.ts'
import { CREDENTIALS_CONTRACT, parseCredentialRef, refLabel } from './credentials/definition.ts'
import { createKernel, type Kernel } from './kernel.ts'
import type { LoadedPlugin } from './types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** Directory of the core package, the fallback location of the default config. */
const CORE_DIR = path.resolve(HERE, '..')

/** Default port of the `serve` status endpoint (published by the dev overlay). */
export const DEFAULT_PORT = 12347

/** Interval of the `serve` heartbeat log line. */
const HEARTBEAT_MS = 60_000

const HELP = `workbench - minimal cordis plugin host

Usage:
  workbench serve [--port <n>]    boot the plugins and keep running (service mode)
  workbench <command> [args...]   run a command registered by a plugin
  workbench plugins               list loaded plugins and their sources
  workbench commands              list registered commands
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
  --port <n>       serve only: status endpoint port (default: $WORKBENCH_PORT or ${DEFAULT_PORT})
  --no-external    skip external plugin sources
  --json           machine readable output
  --help           this text

Environment:
  CONFIG_FILE      config file to use when --config is not given; empty/unset
                   falls back to the default config file lookup described above
  WORKBENCH_PORT   serve only: status endpoint port (default: ${DEFAULT_PORT})
  WORKBENCH_CACHE_DIR  where git plugin sources are checked out
                   (default: <config dir>/.workbench/sources)
`

interface Flags {
  configFile?: string
  includeExternal: boolean
  json: boolean
  port?: number
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

function describePlugin(plugin: LoadedPlugin): string {
  const origin = plugin.external ? `external:${plugin.source}` : plugin.source
  const capabilities = plugin.capabilities.length ? plugin.capabilities.join(', ') : '-'
  return `${plugin.name}@${plugin.version}  ${origin}  [${capabilities}]`
}

function describeSource(source: Kernel['sources'][number]): string {
  return `source ${source.id} (${source.kind}, ${source.external ? 'external' : 'core'}): ${source.dir ?? 'unresolved'} [${source.plugins} plugin(s)]${source.error ? ` error=${source.error}` : ''}`
}

function summaryLine(kernel: Kernel): string {
  const core = kernel.plugins.filter((plugin) => !plugin.external).length
  return `workbench: ${kernel.plugins.length} plugin(s) loaded (${core} core, ${kernel.plugins.length - core} external)`
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
 * Long-running entrypoint used by the compose service: boots the kernel, serves
 * a tiny status endpoint (`GET /health` -> the loaded plugins and sources) and
 * stays up until SIGINT/SIGTERM. Keeping the process alive is the whole point -
 * a container that only sleeps would report `Up` while hosting nothing.
 */
async function serve(kernel: Kernel, port: number): Promise<void> {
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

  const server = http.createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/health' || url === '/' || url.startsWith('/?')) {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(status() + '\n')
      return
    }
    response.writeHead(404, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ status: 'not found', path: url }) + '\n')
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '0.0.0.0', resolve)
  })

  process.stdout.write(`workbench: serving on http://0.0.0.0:${port} config=${kernel.configFile}\n`)
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
  await new Promise<void>((resolve) => server.close(() => resolve()))
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
      await serve(kernel, resolvePort(flags))
    } finally {
      await kernel.dispose()
    }
    return
  }

  const kernel = await createKernel({ configFile: resolveConfigFile(flags), includeExternal: flags.includeExternal })
  try {
    if (head === 'plugins') {
      if (flags.json) {
        process.stdout.write(JSON.stringify({ plugins: kernel.plugins, sources: kernel.sources, configFile: kernel.configFile }, null, 2) + '\n')
        return
      }
      process.stdout.write(summaryLine(kernel) + '\n')
      for (const source of kernel.sources) process.stdout.write(describeSource(source) + '\n')
      for (const plugin of kernel.plugins) process.stdout.write(`  ${describePlugin(plugin)}\n`)
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

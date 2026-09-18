#!/usr/bin/env node
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG_FILE } from './config.ts'
import { createKernel } from './kernel.ts'
import type { LoadedPlugin } from './types.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_CONFIG = path.resolve(HERE, '..', DEFAULT_CONFIG_FILE)

const HELP = `workbench - minimal cordis plugin host

Usage:
  workbench <command> [args...]   run a command registered by a plugin
  workbench plugins               list loaded plugins and their sources
  workbench commands              list registered commands

Options:
  --config <file>  config file to use (default: ${DEFAULT_CONFIG_FILE} next to the core)
  --no-external    skip external plugin sources
  --json           machine readable output
  --help           this text
`

interface Flags {
  configFile: string
  includeExternal: boolean
  json: boolean
  rest: string[]
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { configFile: DEFAULT_CONFIG, includeExternal: true, json: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--config') flags.configFile = path.resolve(process.cwd(), argv[++i] ?? '')
    else if (arg === '--no-external') flags.includeExternal = false
    else if (arg === '--json') flags.json = true
    else flags.rest.push(arg)
  }
  return flags
}

function describePlugin(plugin: LoadedPlugin): string {
  const origin = plugin.external ? `external:${plugin.source}` : plugin.source
  const capabilities = plugin.capabilities.length ? plugin.capabilities.join(', ') : '-'
  return `${plugin.name}@${plugin.version}  ${origin}  [${capabilities}]`
}

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2))
  const [head] = flags.rest
  if (!head || head === 'help' || head === '--help') {
    process.stdout.write(HELP)
    return
  }

  const kernel = await createKernel({ configFile: flags.configFile, includeExternal: flags.includeExternal })
  try {
    if (head === 'plugins') {
      if (flags.json) {
        process.stdout.write(JSON.stringify({ plugins: kernel.plugins, sources: kernel.sources }, null, 2) + '\n')
        return
      }
      const core = kernel.plugins.filter((plugin) => !plugin.external).length
      process.stdout.write(`workbench: ${kernel.plugins.length} plugin(s) loaded (${core} core, ${kernel.plugins.length - core} external)\n`)
      for (const source of kernel.sources) {
        process.stdout.write(`source ${source.id} (${source.kind}, ${source.external ? 'external' : 'core'}): ${source.dir ?? 'unresolved'} [${source.plugins} plugin(s)]${source.error ? ` error=${source.error}` : ''}\n`)
      }
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

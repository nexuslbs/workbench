import path from 'node:path'
import { Context } from 'cordis'
import { findDefaultConfigFile, readConfig } from './config.ts'
import { loadPlugins, type LoadFailure, type SourceReport } from './loader.ts'
import { CommandRegistry } from './registry.ts'
import type { LoadedPlugin, WorkbenchConfig } from './types.ts'

export interface KernelOptions {
  /** Config file to load (default: the first default config file in the working directory). */
  configFile?: string
  /** Pre-loaded config (used by tests instead of a file). */
  config?: WorkbenchConfig
  /** Directory relative source paths resolve against (default: the config file directory). */
  configDir?: string
  /** Set false to skip external sources (`--no-external`). */
  includeExternal?: boolean
  /** Log sink; defaults to stderr so command output stays clean on stdout. */
  log?: (message: string) => void
}

export interface Kernel {
  ctx: Context
  registry: CommandRegistry
  plugins: LoadedPlugin[]
  failures: LoadFailure[]
  sources: SourceReport[]
  dispose(): Promise<void>
}

/**
 * Boots the workbench kernel: create the cordis root context, provide the
 * workbench service, then discover/load every plugin of every configured
 * source (core and external through the same mechanism).
 */
export async function createKernel(options: KernelOptions = {}): Promise<Kernel> {
  const cwd = process.cwd()
  let config: WorkbenchConfig
  let configDir: string

  if (options.config) {
    config = options.config
    configDir = options.configDir ?? cwd
  } else {
    const file = options.configFile ?? findDefaultConfigFile([cwd])
    const loaded = readConfig(file)
    config = loaded.config
    configDir = options.configDir ?? loaded.dir
  }

  const log = options.log ?? ((message: string) => console.error(`[workbench] ${message}`))
  const registry = new CommandRegistry(log)
  const ctx = new Context()
  await ctx.plugin({ name: 'workbench', apply: (c) => { c.provide('workbench', registry) } })

  const report = await loadPlugins(ctx, {
    config,
    configDir,
    cacheDir: path.join(configDir, '.workbench', 'sources'),
    includeExternal: options.includeExternal !== false,
    log,
  })
  registry.setPlugins(report.plugins)

  return {
    ctx,
    registry,
    plugins: report.plugins,
    failures: report.failures,
    sources: report.sources,
    dispose: async () => { await ctx.fiber.dispose() },
  }
}

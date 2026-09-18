/**
 * The four CORE credentials providers, in DECLARATION order. This list is the
 * only place the core knows about concrete providers: they are ordinary plugins
 * of the core package that implement the credentials DEFINITION, and the kernel
 * declares their provider ids so they may register.
 *
 * Order matters: it is the default precedence when the config does not name an
 * explicit `credentials.providers` list. `env` is first because it is the
 * narrowest (a directly exported value beats a file on disk).
 *
 * A provider from ANOTHER repository is loaded like any other external plugin
 * (manifest + entry module) and selected by the same config - it does not
 * appear here.
 */
import type { Context } from 'cordis'
import type { CredentialProvider, CredentialsService } from '../definition.ts'
import * as env from './env.ts'
import * as file from './file.ts'
import * as projectEnv from './project-env.ts'
import * as userEnv from './user-env.ts'

export { env, file, projectEnv, userEnv }

/** One core provider: its id, its config key and how to register it. */
export interface CoreProvider {
  /** Provider id it registers. */
  id: string
  /** Plugin name = the `plugins:` config key that configures it. */
  plugin: string
  /** Module path inside the core package (for docs/reports). */
  module: string
  /** Registers the provider, configured from `plugins[plugin]`. */
  register(ctx: Context & { credentials: CredentialsService }, raw: Record<string, unknown>, configDir: string): void
  /**
   * Creates the provider from the SAME config WITHOUT a cordis context: this is
   * what the BOOTSTRAP set uses, because a source credential has to be resolvable
   * before any plugin (and therefore before `ctx.credentials`) exists.
   */
  create(raw: Record<string, unknown>, configDir: string): CredentialProvider
}

/** How the kernel registers a provider module: one effect, one registration. */
function registerProvider(ctx: Context & { credentials: CredentialsService }, provider: Parameters<CredentialsService['register']>[0]): void {
  ctx.effect(() => ctx.credentials.register(provider))
}

/** The core providers, in precedence (declaration) order. */
export const CORE_PROVIDERS: CoreProvider[] = [
  {
    id: env.providerId,
    plugin: env.name,
    module: 'src/credentials/providers/env.ts',
    register: (ctx, raw) => registerProvider(ctx, env.createProvider(env.resolveConfig(raw))),
    create: (raw) => env.createProvider(env.resolveConfig(raw)),
  },
  {
    id: file.providerId,
    plugin: file.name,
    module: 'src/credentials/providers/file.ts',
    register: (ctx, raw, configDir) => registerProvider(ctx, file.createProvider(file.resolveConfig(raw, configDir))),
    create: (raw, configDir) => file.createProvider(file.resolveConfig(raw, configDir)),
  },
  {
    id: projectEnv.providerId,
    plugin: projectEnv.name,
    module: 'src/credentials/providers/project-env.ts',
    register: (ctx, raw, configDir) => registerProvider(ctx, projectEnv.createProvider(projectEnv.resolveConfig(raw, configDir), configDir)),
    create: (raw, configDir) => projectEnv.createProvider(projectEnv.resolveConfig(raw, configDir), configDir),
  },
  {
    id: userEnv.providerId,
    plugin: userEnv.name,
    module: 'src/credentials/providers/user-env.ts',
    register: (ctx, raw, configDir) => registerProvider(ctx, userEnv.createProvider(userEnv.resolveConfig(raw, configDir))),
    create: (raw, configDir) => userEnv.createProvider(userEnv.resolveConfig(raw, configDir)),
  },
]

/** Provider ids the core ships, in precedence order. */
export const CORE_PROVIDER_IDS = CORE_PROVIDERS.map((provider) => provider.id)

/**
 * Validates a plugin's config for one core provider and registers it. Throws a
 * message naming the config key when the plugin section is not a mapping; the
 * per-provider validation (unknown keys, bad paths) happens in the module.
 */
export function registerCoreProviders(
  ctx: Context & { credentials: CredentialsService },
  plugins: Record<string, Record<string, unknown>> = {},
  configDir: string,
): void {
  for (const provider of CORE_PROVIDERS) {
    const raw = plugins[provider.plugin]
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      throw new Error(`config: 'plugins.${provider.plugin}' must be a mapping (got ${Array.isArray(raw) ? 'array' : typeof raw})`)
    }
    provider.register(ctx, raw ?? {}, configDir)
  }
}

/**
 * CORE credentials provider `env`: the DIRECT process environment.
 *
 * Semantics (documented in `docs/CREDENTIALS.md`): the credential name is
 * looked up in `process.env` exactly, then as its ENV-normalised form
 * (`demo-token` -> `DEMO_TOKEN`). An unset or empty variable is "not found".
 * `ref.scope` is not supported by this provider and is ignored.
 */
import type { Context } from 'cordis'
import { CREDENTIALS_VERSION, type CredentialProvider, type CredentialsService } from '../definition.ts'
import { envKey } from './dotenv.ts'

/** Plugin name (also the per-plugin config key in the workbench config). */
export const name = 'credentials-env'
/** Provider id this module registers. */
export const providerId = 'env'

/** The direct env provider has no backend config. */
export type Config = Record<string, never>

export function resolveConfig(raw: Record<string, unknown> = {}): Config {
  const keys = Object.keys(raw)
  if (keys.length > 0) {
    throw new Error(`credentials-env: unknown config key(s) ${keys.map((key) => JSON.stringify(key)).join(', ')} (this provider has no config)`)
  }
  return {}
}

export function createProvider(config: Config = {}): CredentialProvider {
  void config
  return {
    id: providerId,
    version: CREDENTIALS_VERSION,
    describe: () => 'the process environment (process.env)',
    resolve: (ref) => {
      for (const key of [ref.name, envKey(ref.name)]) {
        const value = process.env[key]
        if (value !== undefined && value !== '') return value
      }
      return undefined
    },
  }
}

export function apply(ctx: Context & { credentials: CredentialsService }, config: Config = {}): void {
  const provider = createProvider(config)
  ctx.effect(() => ctx.credentials.register(provider))
}

export const plugin = { name, inject: ['credentials'], apply }

export default plugin

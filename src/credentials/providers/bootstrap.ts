/**
 * The BOOTSTRAP credentials set: the providers usable BEFORE any plugin is
 * loaded.
 *
 * Source resolution runs BEFORE plugin discovery (kernel phase 1 -> source ->
 * plugin), so a credential needed to FETCH a private `git` source cannot come
 * from a plugin-provided credentials provider - those providers are themselves
 * discovered in a source. This module closes exactly that gap, with the SAME
 * definition the rest of the core speaks ({@link CredentialProvider},
 * {@link CredentialRef}, {@link CredentialResolution}): it instantiates the CORE
 * provider modules directly, from the same `plugins.<provider>` config sections
 * and without a cordis context.
 *
 * Selection is CONFIGURATION: `credentials.bootstrap` names the ids, in
 * precedence order (default: every core provider, in declaration order). Only
 * core ids can be listed - a plugin-provided provider only exists AFTER this
 * point and is therefore never part of the bootstrap set; an unknown id is a
 * loud config error, never a silent fallback.
 *
 * Layering (documented in `docs/CREDENTIALS.md`):
 *
 *   bootstrap set   core providers, NO plugins loaded  -> source fetch (git auth)
 *   ctx.credentials plugin + core providers, post-load -> config `${cred:NAME}`, plugins
 *
 * Both answer the same {@link CredentialConsumer} contract, so a consumer never
 * knows which of the two it talks to.
 *
 * Placement: this module lives in the PROVIDER layer (`src/credentials/providers/`)
 * on purpose. It names the concrete core providers, which only a provider-layer
 * module or the composition root (`src/kernel.ts`, `src/index.ts`) may do;
 * `scripts/check-seam.ts` enforces exactly that, so a consumer (source
 * resolution, config expansion, a plugin) can only ever ask it through the
 * {@link CredentialConsumer} contract.
 */
import {
  CREDENTIALS_CONTRACT,
  normalizeRef,
  refLabel,
  type CredentialConsumer,
  type CredentialProvider,
  type CredentialRef,
  type CredentialResolution,
  type ProviderInfo,
  type ResolutionAttempt,
  type ResolutionTrace,
} from '../definition.ts'
import { CORE_PROVIDERS, CORE_PROVIDER_IDS } from './index.ts'

/** How the bootstrap set is configured (all of it from the config, none from code). */
export interface BootstrapOptions {
  /** Directory the provider configs resolve their relative paths against. */
  configDir: string
  /** `credentials.bootstrap`: provider ids, in precedence order (default: all core ids). */
  providers?: readonly string[]
  /** The `plugins:` section, where each core provider reads its own config. */
  plugins?: Record<string, Record<string, unknown>>
}

/** Core provider ids, in declaration (default precedence) order. */
export function coreProviderIds(): string[] {
  return [...CORE_PROVIDER_IDS]
}

/**
 * Instantiates the bootstrap providers named by the config. Only CORE provider
 * ids are accepted: a plugin-provided provider cannot be available before plugin
 * loading, so listing one is a config error that names what IS available.
 */
export function bootstrapProviders(options: BootstrapOptions): CredentialProvider[] {
  const requested = options.providers && options.providers.length > 0 ? [...options.providers] : [...CORE_PROVIDER_IDS]
  const seen = new Set<string>()
  const providers: CredentialProvider[] = []
  for (const id of requested) {
    if (seen.has(id)) throw new Error(`credentials.bootstrap: provider '${id}' is listed twice`)
    seen.add(id)
    const core = CORE_PROVIDERS.find((candidate) => candidate.id === id)
    if (core === undefined) {
      throw new Error(
        `credentials.bootstrap: '${id}' is not a CORE provider (core providers: ${CORE_PROVIDER_IDS.join(', ')}); ` +
          `a plugin-provided provider only exists AFTER plugins are loaded and can never fetch a source`,
      )
    }
    const raw = options.plugins?.[core.plugin]
    if (raw !== undefined && (raw === null || typeof raw !== 'object' || Array.isArray(raw))) {
      throw new Error(`config: 'plugins.${core.plugin}' must be a mapping (got ${Array.isArray(raw) ? 'array' : typeof raw})`)
    }
    providers.push(core.create(raw ?? {}, options.configDir))
  }
  return providers
}

/**
 * The bootstrap set as a CONSUMER: the same `resolve`/`explain`/`list` surface as
 * `ctx.credentials`, backed by core providers only and usable with no plugin
 * loaded. Nothing here knows about cordis.
 */
export class BootstrapCredentials implements CredentialConsumer {
  protected entries: { id: string; provider: CredentialProvider }[]

  constructor(providers: readonly CredentialProvider[]) {
    this.entries = providers.map((provider) => ({ id: provider.id, provider }))
  }

  /** Enabled provider ids, in precedence order. */
  enabled(): string[] {
    return this.entries.map((entry) => entry.id)
  }

  /** What the bootstrap set is made of (plugin/source are the core's own). */
  providers(): ProviderInfo[] {
    return this.entries.map((entry) => {
      const describe = entry.provider.describe?.()
      return {
        id: entry.id,
        contract: CREDENTIALS_CONTRACT,
        plugin: 'workbench-core',
        source: 'core',
        external: false,
        enabled: true,
        registered: true,
        ...(describe === undefined ? {} : { describe }),
      }
    })
  }

  /** Resolves through the bootstrap providers; the first one answering wins. */
  async resolve(ref: CredentialRef): Promise<CredentialResolution | undefined> {
    const lookup = await this.lookup(ref)
    if (lookup.resolution === undefined) {
      if (lookup.trace.errors.length > 0) {
        throw new Error(`credentials: no bootstrap provider resolved '${refLabel(ref)}' (${lookup.trace.errors.join('; ')})`)
      }
      return undefined
    }
    return lookup.resolution
  }

  /** Same walk as {@link resolve}, reported without any value. */
  async explain(ref: CredentialRef): Promise<ResolutionTrace> {
    return (await this.lookup(ref)).trace
  }

  /** Credential names the bootstrap providers can answer (names only, sorted). */
  async list(): Promise<string[]> {
    const names = new Set<string>()
    for (const entry of this.entries) {
      if (!entry.provider.list) continue
      for (const name of await entry.provider.list()) {
        if (typeof name === 'string' && name.length > 0) names.add(name)
      }
    }
    return [...names].sort()
  }

  protected async lookup(input: CredentialRef): Promise<{ trace: ResolutionTrace; resolution?: CredentialResolution }> {
    const ref = normalizeRef(input)
    const attempts: ResolutionAttempt[] = []
    const errors: string[] = []
    const trace: ResolutionTrace = { ref, attempts, errors }
    for (const entry of this.entries) {
      try {
        const value = await entry.provider.resolve(ref)
        if (value === undefined || value === '') {
          attempts.push({ provider: entry.id, status: 'missing' })
          continue
        }
        attempts.push({ provider: entry.id, status: 'answered' })
        trace.resolvedBy = entry.id
        return {
          trace,
          resolution: { ref, value, provider: entry.id, contract: `${CREDENTIALS_CONTRACT}` },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        attempts.push({ provider: entry.id, status: 'error', error: message })
        errors.push(`${entry.id}: ${message}`)
      }
    }
    return { trace }
  }
}

/** Builds the bootstrap set from the config (core providers, no plugin needed). */
export function bootstrapCredentials(options: BootstrapOptions): BootstrapCredentials {
  return new BootstrapCredentials(bootstrapProviders(options))
}

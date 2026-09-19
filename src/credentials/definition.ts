/**
 * Credentials capability - SERVICE DEFINITION.
 *
 * This module is the CONTRACT of the credentials capability and nothing else:
 * it names no implementation and no backend - it does not know where a value
 * comes from, only how one is asked for. It exists so the three roles of the
 * capability can evolve and be replaced independently:
 *
 *   Provider  ->  Definition  <-  Consumer
 *
 * - PROVIDERS (implementations, shipped by this core or by a plugin from another
 *   repository) implement {@link CredentialProvider} and register themselves
 *   with the service.
 * - CONSUMERS (the config `${cred:NAME}` expansion in `../config.ts`, the CLI
 *   `workbench credentials ...` commands, any plugin) only ever call
 *   {@link CredentialsService.resolve} (and friends). A consumer never imports
 *   a provider; a provider never imports a consumer. `npm run check:seam`
 *   enforces that direction.
 *
 * An external provider is implementable from this module plus the docs alone
 * (`docs/CREDENTIALS.md`): declare the capability in the plugin manifest and
 * register a descriptor implementing the contract version below. This module is
 * re-exported from the core's public API so a plugin in another repository can
 * implement or consume it without reaching into core internals.
 */
import { Service, type Context } from 'cordis'

/** Name of the cordis service (`ctx.credentials`). */
export const CREDENTIALS = 'credentials'

/** Contract version this definition speaks. A provider must implement it. */
export const CREDENTIALS_VERSION = 1

/** Contract id including the version, e.g. `credentials@1`. */
export const CREDENTIALS_CONTRACT = `${CREDENTIALS}@${CREDENTIALS_VERSION}`

/** A reference to a credential. It names a credential, it never carries a value. */
export interface CredentialRef {
  /** Credential name, e.g. `deploy-token`. Never a value. */
  name: string
  /** Optional scope/namespace; only providers that support scopes use it. */
  scope?: string
}

/** A successful resolution: the value plus which provider answered. */
export interface CredentialResolution {
  ref: CredentialRef
  /** The credential value. Callers must not log, echo or persist it. */
  value: string
  /** Id of the provider that answered. */
  provider: string
  /** Contract the answering provider implements. */
  contract: string
}

/**
 * What a provider (implementation) must offer. Everything here is backend
 * agnostic: the definition does not know where a value comes from.
 */
export interface CredentialProvider {
  /** Provider id, unique among providers (e.g. `env`, `file`, `vault`). */
  id: string
  /** Contract version implemented; must equal {@link CREDENTIALS_VERSION}. */
  version: number
  /** Resolves a reference, or returns undefined when this provider cannot answer. */
  resolve(ref: CredentialRef): string | undefined | Promise<string | undefined>
  /** Optional: credential names this provider can answer (names only, no values). */
  list?(): string[] | Promise<string[]>
  /** Optional: human readable backend description (never contains values). */
  describe?(): string
}

/**
 * A provider declaration: which plugin claims which provider id of which
 * contract version. Declarations come from plugin MANIFESTS (the `capabilities`
 * field, structured form) and from the core provider modules; a provider whose
 * id was never declared cannot register.
 */
export interface ProviderDeclaration {
  /** Provider id claimed. */
  provider: string
  /** Contract version claimed. */
  version: number
  /** Plugin that claims it (manifest name, or the core provider module name). */
  plugin: string
  /** Source id the plugin came from (`core` for the core providers). */
  source: string
  /** True when the declaring plugin came from an external source. */
  external: boolean
}

/** Status of one enabled provider for one reference. Never carries a value. */
export interface ResolutionAttempt {
  provider: string
  status: 'answered' | 'missing' | 'error' | 'not-registered'
  /** Provider error message (provider authored; must never contain a value). */
  error?: string
}

/** What resolution did, reference by reference: names and providers, no values. */
export interface ResolutionTrace {
  ref: CredentialRef
  /** Provider id that answered, when one did. */
  resolvedBy?: string
  attempts: ResolutionAttempt[]
  /** Errors raised by enabled providers, prefixed with their id. */
  errors: string[]
}

/** Public view of a provider: who declared it, is it registered, is it enabled. */
export interface ProviderInfo {
  id: string
  contract: string
  /** Plugin that declared the provider id. */
  plugin: string
  source: string
  external: boolean
  /** True when the provider is in the enabled (precedence) list. */
  enabled: boolean
  /** True when a provider implementation registered for this declaration. */
  registered: boolean
  /** Provider backend description, when it offers one. */
  describe?: string
}

/** Reference label used in messages: `name` or `scope/name`. Never a value. */
export function refLabel(ref: CredentialRef): string {
  return ref.scope ? `${ref.scope}/${ref.name}` : ref.name
}

/** Validates a reference; only names appear in errors, never values. */
export function assertRef(ref: CredentialRef): void {
  if (!ref || typeof ref.name !== 'string' || ref.name.length === 0) {
    throw new Error('credentials: a credential reference needs a non-empty name')
  }
  if (ref.scope !== undefined && (typeof ref.scope !== 'string' || ref.scope.length === 0)) {
    throw new Error(`credentials: the scope of '${ref.name}' must be a non-empty string`)
  }
}

/**
 * Parses a reference spec: `NAME` or `SCOPE/NAME`. Only the reference appears in
 * errors; a reference never carries a value.
 */
export function parseCredentialRef(spec: string): CredentialRef {
  const body = spec.trim()
  if (body.length === 0) throw new Error('credentials: an empty credential reference is not allowed')
  const separator = body.indexOf('/')
  if (separator < 0) return { name: body }
  const scope = body.slice(0, separator).trim()
  const name = body.slice(separator + 1).trim()
  if (scope.length === 0 || name.length === 0) {
    throw new Error(`credentials: malformed reference '${spec}' (expected NAME or SCOPE/NAME)`)
  }
  return { scope, name }
}

/**
 * Normalises a reference: `NAME` may also be written `SCOPE/NAME`, so a
 * qualified name is split into a scope and a name before any provider sees it.
 * Validates the reference as a side effect (only names appear in errors).
 */
export function normalizeRef(ref: CredentialRef): CredentialRef {
  assertRef(ref)
  if (ref.scope === undefined && ref.name.includes('/')) return parseCredentialRef(ref.name)
  return ref
}

interface ProviderEntry {
  descriptor: CredentialProvider
  declaration: ProviderDeclaration
}

/**
 * The service of the capability. The abstract part is the CONSUMER contract
 * (`resolve`, `explain`, `list`); the concrete part is the PROVIDER contract
 * (declarations, registration, selection), implemented once here so every
 * implementation of the definition shares it. It contains no backend logic.
 */
export abstract class CredentialsService extends Service {
  // Plain (runtime) properties, not `#private`: cordis wraps a service instance
  // in a Proxy for dependency tracking, and a Proxy breaks private-field access
  // (`this.#x` -> "Cannot read private member from an object whose class did not
  // declare it").
  protected declarations = new Map<string, ProviderDeclaration>()
  protected implementations = new Map<string, ProviderEntry>()
  protected enabledIds: string[] | undefined

  constructor(ctx: Context, name: string = CREDENTIALS) {
    super(ctx, name)
  }

  /** Resolves a reference through the enabled providers (first answering wins). */
  abstract resolve(ref: CredentialRef): Promise<CredentialResolution | undefined>
  /** What each enabled provider did for a reference (no values). */
  abstract explain(ref: CredentialRef): Promise<ResolutionTrace>
  /** Credential names the enabled providers can answer (names only). */
  abstract list(): Promise<string[]>

  /** Registers a provider declaration (from a manifest or a core provider module). */
  declare(declaration: ProviderDeclaration): void {
    if (!declaration.provider) throw new Error('credentials: a provider declaration needs a provider id')
    if (declaration.version !== CREDENTIALS_VERSION) {
      throw new Error(
        `credentials: plugin '${declaration.plugin}' declares provider '${declaration.provider}' for contract version ` +
          `${declaration.version}, but this core speaks ${CREDENTIALS_CONTRACT}`,
      )
    }
    const existing = this.declarations.get(declaration.provider)
    if (existing) {
      if (existing.plugin === declaration.plugin) return
      throw new Error(
        `credentials: provider id '${declaration.provider}' is declared twice (by '${existing.plugin}' and ` +
          `'${declaration.plugin}'); provider ids must be unique`,
      )
    }
    this.declarations.set(declaration.provider, declaration)
  }

  /**
   * Registers a provider implementation. Refuses providers whose id or contract
   * version was not declared by a manifest (or by a core provider module), so
   * the MANIFEST is what makes a provider resolvable. Returns the disposer.
   */
  register(descriptor: CredentialProvider): () => void {
    if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
      throw new Error('credentials: register() needs a provider id')
    }
    if (typeof descriptor.resolve !== 'function') {
      throw new Error(`credentials: provider '${descriptor.id}' must implement resolve()`)
    }
    const declaration = this.declarations.get(descriptor.id)
    if (!declaration) {
      throw new Error(
        `credentials: provider '${descriptor.id}' is not declared; declare it in the plugin manifest: ` +
          `"capabilities": [{ "id": "${CREDENTIALS}", "version": ${CREDENTIALS_VERSION}, "provider": "${descriptor.id}" }]`,
      )
    }
    if (descriptor.version !== CREDENTIALS_VERSION) {
      throw new Error(
        `credentials: provider '${descriptor.id}' implements contract version ${descriptor.version}, ` +
          `but this core speaks ${CREDENTIALS_CONTRACT}`,
      )
    }
    if (this.implementations.has(descriptor.id)) {
      throw new Error(`credentials: provider '${descriptor.id}' is already registered`)
    }
    const entry: ProviderEntry = { descriptor, declaration }
    this.implementations.set(descriptor.id, entry)
    return () => {
      if (this.implementations.get(descriptor.id) === entry) this.implementations.delete(descriptor.id)
    }
  }

  /**
   * Fixes the enabled providers and their precedence order. This is the ONLY
   * place provider selection happens, and it is fed by configuration.
   */
  setEnabled(ids?: readonly string[]): void {
    const requested = ids && ids.length > 0 ? [...ids] : [...this.declarations.keys()]
    const seen = new Set<string>()
    for (const id of requested) {
      if (seen.has(id)) throw new Error(`credentials: provider '${id}' is listed twice in the enabled providers`)
      seen.add(id)
      if (!this.declarations.has(id)) {
        const available = [...this.declarations.keys()]
        throw new Error(
          `credentials: provider '${id}' is not declared by any plugin (available: ` +
            `${available.length ? available.join(', ') : 'none'}); a provider must declare the capability in its ` +
            `manifest: "capabilities": [{ "id": "${CREDENTIALS}", "version": ${CREDENTIALS_VERSION}, "provider": "id" }]`,
        )
      }
    }
    // Declared but not selected providers stay registered; they never answer.
    this.enabledIds = requested
  }

  /** Enabled provider ids, in precedence order. */
  enabled(): string[] {
    return this.enabledIds ? [...this.enabledIds] : [...this.declarations.keys()]
  }

  /** Every known provider declaration, registered or not, enabled or not. */
  providers(): ProviderInfo[] {
    const enabled = new Set(this.enabled())
    return [...this.declarations.values()].map((declaration) => {
      const entry = this.implementations.get(declaration.provider)
      const describe = entry?.descriptor.describe?.()
      return {
        id: declaration.provider,
        contract: `${CREDENTIALS}@${declaration.version}`,
        plugin: declaration.plugin,
        source: declaration.source,
        external: declaration.external,
        enabled: enabled.has(declaration.provider),
        registered: entry !== undefined,
        ...(describe === undefined ? {} : { describe }),
      }
    })
  }

  /** Registered provider lookup, for implementations of {@link resolve}. */
  protected entry(id: string): CredentialProvider | undefined {
    return this.implementations.get(id)?.descriptor
  }
}

/**
 * The default implementation of the definition: it walks the enabled providers
 * in precedence order and returns the first value. The walk is the definition's
 * own logic (no backend knowledge), so providers stay replaceable.
 */
export class Credentials extends CredentialsService {
  /** Resolves through the enabled providers; the first one answering wins. */
  async resolve(ref: CredentialRef): Promise<CredentialResolution | undefined> {
    const lookup = await this.lookup(ref)
    if (lookup.resolution === undefined) {
      if (lookup.trace.errors.length > 0) {
        throw new Error(`credentials: no provider resolved '${refLabel(ref)}' (${lookup.trace.errors.join('; ')})`)
      }
      return undefined
    }
    return lookup.resolution
  }

  /** Same walk as {@link resolve}, reported without any value. */
  async explain(ref: CredentialRef): Promise<ResolutionTrace> {
    return (await this.lookup(ref)).trace
  }

  /** Credential names the enabled providers can answer (names only, sorted). */
  async list(): Promise<string[]> {
    const names = new Set<string>()
    for (const id of this.enabled()) {
      const provider = this.entry(id)
      if (!provider?.list) continue
      for (const name of await provider.list()) {
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
    for (const id of this.enabled()) {
      const provider = this.entry(id)
      if (!provider) {
        attempts.push({ provider: id, status: 'not-registered' })
        continue
      }
      try {
        const value = await provider.resolve(ref)
        if (value === undefined || value === '') {
          attempts.push({ provider: id, status: 'missing' })
          continue
        }
        attempts.push({ provider: id, status: 'answered' })
        trace.resolvedBy = id
        return {
          trace,
          resolution: { ref, value, provider: id, contract: `${CREDENTIALS}@${provider.version}` },
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        attempts.push({ provider: id, status: 'error', error: message })
        errors.push(`${id}: ${message}`)
      }
    }
    return { trace }
  }
}

/**
 * The CONSUMER slice of the capability: what a consumer is allowed to call.
 * {@link CredentialsService} satisfies it structurally (that is what
 * `ctx.credentials` is), and it is the interface the kernel injects when it
 * resolves a gated source: the core ships NO provider, so source auth is only
 * attempted once a provider PLUGIN has registered, and a credential-dependent
 * source with no provider loaded is DEFERRED. A consumer depends on this
 * interface - never on a provider.
 */
export interface CredentialConsumer {
  /** Resolves a reference through the enabled providers (first answering wins). */
  resolve(ref: CredentialRef): Promise<CredentialResolution | undefined>
  /** What each enabled provider did for a reference (no values). */
  explain(ref: CredentialRef): Promise<ResolutionTrace>
  /** Credential names the enabled providers can answer (names only). */
  list(): Promise<string[]>
  /** Enabled provider ids, in precedence order. */
  enabled(): string[]
}

/**
 * Typed handle for every consumer/provider module: `ctx.credentials`. Consumers
 * import the DEFINITION (never a provider) and get full typing from this.
 */
declare module 'cordis' {
  interface Context {
    credentials: CredentialsService
  }
}

/**
 * SOURCE AUTHENTICATION: turning a credential REFERENCE in the config into a
 * TRANSIENT git auth argument for a private `git` source.
 *
 * Why the caller injects a {@link CredentialConsumer}: a source is fetched
 * BEFORE any plugin is discovered and the core ships NO credential provider
 * (operator rule: the core is minimal), so the KERNEL resolves in two phases: it
 * fetches the credential-free sources first (that is where a credentials provider
 * PLUGIN comes from), and only once a provider has been registered does it
 * resolve an `auth` source through the live credentials service
 * (`ctx.credentials`), which satisfies this interface. This module therefore never
 * names a provider and never depends on plugin loading; a credential-dependent
 * source with no provider loaded is DEFERRED instead.
 *
 * The core knows exactly ONE git auth TYPE:
 * - `token` (default): the credential value IS the token (a PAT, a GitHub App
 *   installation token minted elsewhere, any HTTPS token).
 *
 * Every other type (`github-app`, and any future backend) is a GIT AUTH STRATEGY
 * a PLUGIN registers with the credentials service
 * (`ctx.credentials.registerGitAuth({ type, args })`, e.g. the PUBLIC
 * `nexuslbs/workbench-plugins` plugin `credentials-github-app`, which mints a
 * short-lived installation token from the App private key). This module only
 * DISPATCHES by `auth.type`: it holds no JWT, no token minting and no
 * backend-specific branch, so the same reduction applies to every future
 * backend without touching the core again.
 *
 * Secret hygiene: the value is never written anywhere. The git argument is
 * `-c http.extraheader=Authorization: Basic <base64(user:token)>` plus
 * `-c credential.helper=` (so no configured helper can persist anything), the
 * remote URL stays the plain configured url, and `src/sources.ts` redacts the
 * header when it reports a failing git command. Errors name the credential
 * REFERENCE, the auth TYPE and, at most, an HTTP status - never the value.
 */
import type { CredentialConsumer, CredentialRef, CredentialResolution } from './credentials/definition.ts'
import { normalizeRef, refLabel } from './credentials/definition.ts'
import { sourceId, type SourceAuthOutcome } from './sources.ts'
import type { SourceAuthSpec, WorkbenchConfig } from './types.ts'

/** Default username of the basic auth header (GitHub wants any non-empty name). */
export const DEFAULT_USERNAME = 'x-access-token'

export interface SourceAuthOptions {
  /** The credentials consumer the kernel injects; without one an `auth` source is DEFERRED. */
  credentials?: CredentialConsumer
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The TRANSIENT git auth arguments: an `http.extraheader` (passed to a single
 * git invocation, never written to `.git/config`) plus an empty
 * `credential.helper`, which disables any helper git might otherwise use to
 * store or replay a credential. The token appears in the process arguments of
 * that one command only, and never in an error message (`src/sources.ts`
 * redacts it).
 */
export function gitAuthArgs(token: string, username: string = DEFAULT_USERNAME): string[] {
  const basic = Buffer.from(`${username}:${token}`, 'utf8').toString('base64')
  return ['-c', 'credential.helper=', '-c', `http.extraheader=Authorization: Basic ${basic}`]
}

/**
 * Resolves the auth of ONE source into git arguments, or into an error that
 * names what is missing. Never throws: the caller reports the error on the
 * source (loudly) instead of fetching it anonymously.
 *
 * The dispatch is the whole contract: `token` is built in, every other
 * `auth.type` is answered by the git auth strategy a PLUGIN registered on the
 * credentials service. A type with no registered strategy is an ERROR naming the
 * type - never a silent anonymous fetch and never a core-side fallback.
 */
export async function resolveSourceAuth(auth: SourceAuthSpec, options: SourceAuthOptions = {}): Promise<SourceAuthOutcome> {
  const type = (auth.type ?? 'token').trim() || 'token'
  let ref: CredentialRef
  try {
    ref = normalizeRef({ name: auth.credential })
  } catch (error) {
    return { ok: false, error: `'auth.credential' is not a valid reference: ${message(error)}` }
  }
  const label = refLabel(ref)
  const credentials = options.credentials
  if (credentials === undefined) {
    return {
      ok: false,
      error:
        `credential '${label}' (type ${type}) cannot be resolved: no plugin implementing the credentials@1 service definition is loaded. A source credential is resolved through the LIVE ` +
        `credentials service, and the core ships NO provider: load a credentials provider plugin (from the PUBLIC ` +
        `nexuslbs/workbench-plugins repo) through a source that needs no credential, then this source becomes loadable`,
    }
  }

  let resolution: CredentialResolution | undefined
  try {
    resolution = await credentials.resolve(ref)
  } catch (error) {
    return {
      ok: false,
      error: `credential '${label}' could not be resolved by the credentials providers (${credentials.enabled().join(', ') || 'none'}): ${message(error)}`,
    }
  }
  if (resolution === undefined) {
    return {
      ok: false,
      error:
        `credential '${label}' was not found by any credentials provider (${credentials.enabled().join(', ') || 'none'}); ` +
        `export it (env provider) or list it in the configured credentials file`,
    }
  }

  if (type === 'token') {
    return {
      ok: true,
      args: gitAuthArgs(resolution.value, auth.username ?? DEFAULT_USERNAME),
      mechanism: `token credential '${label}'`,
      credential: label,
      provider: resolution.provider,
    }
  }

  // Every non-builtin type is a PLUGIN-provided git auth strategy. The core
  // holds no backend: it looks the handler up by type and hands it the resolved
  // VALUE in memory only.
  const handler = credentials.gitAuth?.(type)
  if (handler === undefined) {
    const known = credentials.gitAuthTypes?.() ?? []
    return {
      ok: false,
      error:
        `credential '${label}' needs the git auth type '${type}', which no loaded plugin provides: the core ships NO ` +
        `backend for it (only the built-in 'token'). Load a plugin registering a git auth handler for '${type}' ` +
        `(e.g. the PUBLIC nexuslbs/workbench-plugins plugin 'credentials-github-app') through a source that needs no ` +
        `credential. Registered types: ${known.length ? known.join(', ') : '(none)'}`,
    }
  }

  try {
    const args = await handler.args({ ref, value: resolution.value, auth: { ...(auth as unknown as Record<string, unknown>) } })
    return {
      ok: true,
      args,
      mechanism: `credential '${label}' via the '${type}' git auth handler`,
      credential: label,
      provider: resolution.provider,
    }
  } catch (error) {
    return { ok: false, error: `credential '${label}' could not be turned into git auth: ${message(error)}` }
  }
}

/**
 * Resolves the auth of EVERY `git` source that declares one, keyed by source id
 * (the same id the loader reports). Runs BEFORE any fetch, so a bad credential
 * is reported on the source and the source is skipped - never a silent
 * anonymous attempt against a private remote.
 */
export async function resolveSourceAuths(
  config: WorkbenchConfig,
  options: { configDir: string } & SourceAuthOptions,
): Promise<Map<string, SourceAuthOutcome>> {
  const auths = new Map<string, SourceAuthOutcome>()
  for (const spec of config.sources ?? []) {
    if (spec.kind !== 'git' || spec.auth === undefined) continue
    auths.set(sourceId(spec, options.configDir), await resolveSourceAuth(spec.auth, options))
  }
  return auths
}

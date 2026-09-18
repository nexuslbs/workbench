/**
 * SOURCE AUTHENTICATION: turning a credential REFERENCE in the config into a
 * TRANSIENT git auth argument for a private `git` source.
 *
 * Why a bootstrap path (and not `ctx.credentials`): a source is fetched BEFORE
 * any plugin is discovered, so the provider that answers must exist without a
 * plugin. The caller injects the BOOTSTRAP credential set
 * (`src/credentials/providers/bootstrap.ts`, core providers only) as a
 * {@link CredentialConsumer} - the same contract `ctx.credentials` implements -
 * so this module never names a provider and never depends on plugin loading.
 *
 * Two credential TYPES:
 * - `token` (default): the credential value IS the token (a PAT, a GitHub App
 *   installation token minted elsewhere, any HTTPS token),
 * - `github-app`: the credential value is a GitHub App PRIVATE KEY (PEM). A
 *   short-lived installation access token is minted from it with an RS256 JWT
 *   (`POST {apiBase}/app/installations/{installationId}/access_tokens`, the
 *   documented GitHub App REST flow), so the operator version NOTHING and no
 *   long-lived token exists. Tokens expire after ~1h and are cached in MEMORY
 *   with a safety skew: a long-running serve mints a fresh token on its next
 *   source resolution instead of failing on an expired one.
 *
 * Secret hygiene: the value is never written anywhere. The git argument is
 * `-c http.extraheader=Authorization: Basic <base64(user:token)>` plus
 * `-c credential.helper=` (so no configured helper can persist anything), the
 * remote URL stays the plain configured url, and `src/sources.ts` redacts the
 * header when it reports a failing git command. Errors name the credential
 * REFERENCE and the HTTP status - never the value.
 */
import { createSign } from 'node:crypto'
import type { CredentialConsumer, CredentialRef, CredentialResolution } from './credentials/definition.ts'
import { normalizeRef, refLabel } from './credentials/definition.ts'
import { sourceId, type SourceAuthOutcome } from './sources.ts'
import type { SourceAuthSpec, WorkbenchConfig } from './types.ts'

/** Default GitHub REST API base (GitHub Enterprise sets `auth.apiBase`). */
export const DEFAULT_API_BASE = 'https://api.github.com'
/** Installation tokens live ~1h; refresh this long before the reported expiry. */
export const TOKEN_SKEW_MS = 5 * 60 * 1000
/** Default username of the basic auth header (GitHub wants any non-empty name). */
export const DEFAULT_USERNAME = 'x-access-token'

export interface SourceAuthOptions {
  /** The bootstrap credential set; without it an `auth` source cannot be fetched. */
  credentials?: CredentialConsumer
  /** Injectable fetch (tests); defaults to the global fetch. */
  fetchImpl?: typeof fetch
  /** Injectable clock (tests); defaults to `Date.now`. */
  now?: () => number
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function truncate(text: string): string {
  const body = text.replace(/\s+/g, ' ').trim()
  return body.length > 300 ? `${body.slice(0, 300)}...` : body
}

/** Strips any `"token": "..."` value out of an echoed API body. */
function redactToken(text: string): string {
  return text.replace(/("token"\s*:\s*")[^"]*(")/g, '$1<redacted>$2')
}

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url')
}

/** Validates a numeric GitHub id (a string would be injectable into the URL path). */
function numericId(value: number | string | undefined, field: string): string {
  const text = typeof value === 'number' ? String(value) : (value ?? '').trim()
  if (!/^[0-9]+$/.test(text)) {
    throw new Error(`github-app: '${field}' must be a numeric id (name it in the source 'auth' block); got ${JSON.stringify(value)}`)
  }
  return text
}

/**
 * Builds the App JWT: RS256 over `base64url(header).base64url(claims)` with the
 * App private key. `iat` is backdated 60s (clock skew) and `exp` is +9 minutes,
 * inside GitHub's 10 minute maximum - the documented app-authentication flow.
 */
export function githubAppJwt(options: { appId: number | string; privateKey: string; now?: number }): string {
  const appId = numericId(options.appId, 'appId')
  const seconds = Math.floor((options.now ?? Date.now()) / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(JSON.stringify({ iat: seconds - 60, exp: seconds + 540, iss: appId }))
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  signer.end()
  const signature = signer.sign(options.privateKey).toString('base64url')
  return `${header}.${claims}.${signature}`
}

/** In-memory installation token cache, keyed by `appId:installationId`. */
const installationTokens = new Map<string, { token: string; expiresAt: number }>()

/** Drops cached installation tokens (tests; a serve never needs it). */
export function clearInstallationTokenCache(): void {
  installationTokens.clear()
}

export interface GitHubAppTokenOptions {
  appId: number | string
  installationId: number | string
  /** The App private key (PEM) - the credential VALUE; never logged. */
  privateKey: string
  apiBase?: string
  fetchImpl?: typeof fetch
  now?: () => number
}

/**
 * Mints (or reuses a cached) GitHub App installation access token:
 * RS256 JWT -> `POST /app/installations/{installation_id}/access_tokens`
 * (Accept: application/vnd.github+json, X-GitHub-Api-Version: 2022-11-28),
 * which answers `{ "token": "ghs_...", "expires_at": "<ISO>" }`.
 */
export async function githubAppInstallationToken(options: GitHubAppTokenOptions): Promise<{ token: string; expiresAt: number }> {
  const appId = numericId(options.appId, 'appId')
  const installationId = numericId(options.installationId, 'installationId')
  const now = (options.now ?? Date.now)()
  const key = `${appId}:${installationId}`
  const cached = installationTokens.get(key)
  if (cached !== undefined && cached.expiresAt - TOKEN_SKEW_MS > now) return cached

  const apiBase = (options.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, '')
  const jwt = githubAppJwt({ appId, privateKey: options.privateKey, now })
  const doFetch = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await doFetch(`${apiBase}/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${jwt}`,
        'x-github-api-version': '2022-11-28',
        'content-type': 'application/json',
        'user-agent': 'workbench-core',
      },
      body: '{}',
    })
  } catch (error) {
    throw new Error(`github-app: cannot reach ${apiBase} to mint an installation token (${message(error)})`)
  }
  const text = await response.text()
  if (!response.ok) {
    throw new Error(
      `github-app: minting an installation token for app ${appId} / installation ${installationId} failed (HTTP ${response.status}): ` +
        `${truncate(redactToken(text)) || '(no body)'}`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`github-app: unexpected non-JSON response from ${apiBase}: ${truncate(redactToken(text))}`)
  }
  const body = parsed as { token?: unknown; expires_at?: unknown }
  if (typeof body.token !== 'string' || body.token.length === 0) {
    throw new Error(`github-app: ${apiBase} returned no installation token (app ${appId} / installation ${installationId})`)
  }
  const parsedExpiry = typeof body.expires_at === 'string' ? Date.parse(body.expires_at) : Number.NaN
  const entry = {
    token: body.token,
    expiresAt: Number.isFinite(parsedExpiry) ? parsedExpiry : now + 50 * 60 * 1000,
  }
  installationTokens.set(key, entry)
  return entry
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
 */
export async function resolveSourceAuth(auth: SourceAuthSpec, options: SourceAuthOptions = {}): Promise<SourceAuthOutcome> {
  const type = auth.type ?? 'token'
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
        `credential '${label}' (type ${type}) cannot be resolved: this run has no BOOTSTRAP credential set. A source credential ` +
        `must be resolvable BEFORE plugins load (the source fetch happens first); the bootstrap set is the core provider list ` +
        `('credentials.bootstrap'), configured from the 'plugins.<provider>' sections`,
    }
  }

  let resolution: CredentialResolution | undefined
  try {
    resolution = await credentials.resolve(ref)
  } catch (error) {
    return {
      ok: false,
      error: `credential '${label}' could not be resolved by the bootstrap providers (${credentials.enabled().join(', ') || 'none'}): ${message(error)}`,
    }
  }
  if (resolution === undefined) {
    return {
      ok: false,
      error:
        `credential '${label}' was not found by any bootstrap provider (${credentials.enabled().join(', ') || 'none'}); ` +
        `export it (env provider) or list it in the configured credentials file`,
    }
  }

  try {
    if (type === 'github-app') {
      const minted = await githubAppInstallationToken({
        appId: auth.appId ?? '',
        installationId: auth.installationId ?? '',
        privateKey: resolution.value,
        ...(auth.apiBase === undefined ? {} : { apiBase: auth.apiBase }),
        ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
        ...(options.now === undefined ? {} : { now: options.now }),
      })
      return {
        ok: true,
        args: gitAuthArgs(minted.token, auth.username ?? DEFAULT_USERNAME),
        mechanism: `github-app installation token (app ${auth.appId} / installation ${auth.installationId})`,
        credential: label,
        provider: resolution.provider,
      }
    }
    return {
      ok: true,
      args: gitAuthArgs(resolution.value, auth.username ?? DEFAULT_USERNAME),
      mechanism: `token credential '${label}'`,
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

// SOURCE AUTHENTICATION tests (`src/source-auth.ts`).
//
// The core SHIPS NO CREDENTIAL PROVIDER (operator rule 2026-09-19): a provider
// is a plugin from an external source. These tests therefore drive the module
// through the CONSUMER contract (`CredentialConsumer`) with a fake consumer -
// never through a provider implementation, which does not exist in this repo.
//
// What is asserted: a credential REFERENCE becomes a TRANSIENT git auth
// argument, the VALUE never leaks into the arguments or the error text, and a
// missing/unresolvable credential fails LOUDLY (structured error naming the
// reference) instead of silently fetching anonymously.
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import {
  clearInstallationTokenCache,
  gitAuthArgs,
  githubAppInstallationToken,
  githubAppJwt,
  resolveSourceAuth,
  resolveSourceAuths,
} from '../src/source-auth.ts'
import { redactArgs, sourceId } from '../src/sources.ts'
import type { CredentialConsumer, CredentialRef, CredentialResolution } from '../src/credentials/definition.ts'
import type { WorkbenchConfig } from '../src/types.ts'

/** A fake value: never a real credential, and asserted to be non-leaking below. */
const TOKEN = 'example-token-value-never-a-real-secret'
const APP_KEY_REF = 'example-app-key'

/**
 * A CONSUMER that answers from a map - the structural `CredentialConsumer` the
 * core speaks. It stands in for the credentials SERVICE (which the kernel
 * hosts); it is NOT a provider.
 */
function consumer(values: Record<string, string>, enabled: string[] = ['fixture']): CredentialConsumer {
  return {
    async resolve(ref: CredentialRef): Promise<CredentialResolution | undefined> {
      const label = ref.scope ? `${ref.scope}/${ref.name}` : ref.name
      const value = values[label]
      if (value === undefined) return undefined
      return { ref, value, provider: 'fixture', contract: 'credentials@1' }
    },
    async explain() {
      throw new Error('explain() is not used by the source-auth tests')
    },
    async list() {
      return Object.keys(values)
    },
    enabled: () => enabled,
  }
}

function rsaKey(): string {
  return generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).privateKey
}

test('source auth: a token credential becomes a transient git auth argument', async () => {
  const auth = await resolveSourceAuth(
    { credential: 'demo-token', type: 'token' },
    { credentials: consumer({ 'demo-token': TOKEN }) },
  )
  assert.equal(auth.ok, true)
  assert.ok(auth.ok)
  assert.match(auth.mechanism, /token credential 'demo-token'/)
  assert.equal(auth.credential, 'demo-token')
  assert.equal(auth.provider, 'fixture')
  // No configured helper may persist anything.
  assert.ok(auth.args.includes('credential.helper='))
  const header = auth.args.find((arg) => arg.startsWith('http.extraheader='))
  assert.ok(header !== undefined)
  const encoded = header.slice('http.extraheader='.length)
  assert.ok(encoded.startsWith('Authorization: Basic '))
  const decoded = Buffer.from(encoded.slice('Authorization: Basic '.length), 'base64').toString()
  assert.match(decoded, /^[^:]+:/)
  assert.equal(decoded.slice(decoded.indexOf(':') + 1), TOKEN)
  // The VALUE never appears in the arguments, and the reporting path redacts.
  assert.ok(!auth.args.some((arg) => arg.includes(TOKEN)))
  assert.ok(!redactArgs(auth.args).includes(header))
})

test('source auth: a credential no provider can answer fails loudly, naming the reference', async () => {
  const auth = await resolveSourceAuth(
    { credential: 'missing-token' },
    { credentials: consumer({}, ['fixture', 'file']) },
  )
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /missing-token/)
  assert.match(auth.error, /fixture, file/)
  assert.match(auth.error, /not found/)
})

test('source auth: a consumer that throws is reported, never swallowed', async () => {
  const throwing: CredentialConsumer = {
    async resolve(): Promise<CredentialResolution | undefined> {
      throw new Error('the backend is unreachable')
    },
    async explain() {
      throw new Error('not used')
    },
    async list() {
      return []
    },
    enabled: () => ['broken'],
  }
  const auth = await resolveSourceAuth({ credential: 'demo-token' }, { credentials: throwing })
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /demo-token/)
  assert.match(auth.error, /broken/)
  assert.match(auth.error, /the backend is unreachable/)
})

test('source auth: without a credentials consumer the entry fails loudly (no anonymous retry)', async () => {
  const auth = await resolveSourceAuth({ credential: 'demo-token' })
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /demo-token/)
  assert.match(auth.error, /no plugin implementing the credentials@1 service definition is loaded/)
})

test('source auth: an invalid reference is a structured error, not a throw', async () => {
  const auth = await resolveSourceAuth({ credential: '   ' }, { credentials: consumer({}) })
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /credential/)
})

test('source auth (github-app): the key reference is exchanged for a short-lived installation token', async () => {
  const privateKey = rsaKey()
  const calls: string[] = []
  const fetchImpl = (async (url: string | URL) => {
    calls.push(String(url))
    return new Response(JSON.stringify({ token: 'ghs_example_installation_token' }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const auth = await resolveSourceAuth(
    { credential: APP_KEY_REF, type: 'github-app', appId: 3967918, installationId: 138119822 },
    { credentials: consumer({ [APP_KEY_REF]: privateKey }), fetchImpl },
  )
  assert.equal(auth.ok, true)
  assert.ok(auth.ok)
  assert.match(auth.mechanism, /github-app installation token/)
  assert.match(auth.mechanism, /3967918/)
  assert.equal(auth.credential, APP_KEY_REF)
  assert.equal(calls.length, 1)
  assert.match(calls[0]!, /\/app\/installations\/138119822\/access_tokens$/)
  // The minted TOKEN is in the args, the private KEY (the credential value) is not.
  const joined = auth.args.join(' ')
  assert.ok(!joined.includes(privateKey.split('\n')[1]!))
})

test('githubAppJwt signs an RS256 JWT for the app id', () => {
  const jwt = githubAppJwt({ appId: 3967918, privateKey: rsaKey(), now: 1_700_000_000 })
  const parts = jwt.split('.')
  assert.equal(parts.length, 3)
  const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string; typ?: string }
  const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as { iss?: unknown; iat?: number; exp?: number }
  assert.equal(header.alg, 'RS256')
  assert.equal(String(payload.iss), '3967918')
  assert.ok((payload.exp ?? 0) > (payload.iat ?? 0))
  assert.ok(parts[2]!.length > 100)
})

test('githubAppInstallationToken mints through the GitHub App REST flow', async () => {
  // The github-app RESOLUTION test above minted a token for the SAME
  // app/installation: the token cache is process wide, so clear it to mint here.
  clearInstallationTokenCache()
  const calls: Array<{ url: string; method?: string }> = []
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method })
    return new Response(JSON.stringify({ token: 'ghs_minted', expires_at: new Date(Date.now() + 3_600_000).toISOString() }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  const minted = await githubAppInstallationToken({
    appId: 3967918,
    installationId: 138119822,
    privateKey: rsaKey(),
    fetchImpl,
  })
  assert.equal(minted.token, 'ghs_minted')
  assert.equal(calls.length, 1)
  assert.equal(calls[0]!.method, 'POST')
  assert.match(calls[0]!.url, /^https:\/\/api\.github\.com\/app\/installations\/138119822\/access_tokens$/)
})

test('gitAuthArgs never persists the token: no helper, no url credential', () => {
  const args = gitAuthArgs('example-token', 'x-access-token')
  assert.ok(args.includes('credential.helper='))
  const header = args.find((arg) => arg.startsWith('http.extraheader='))!
  assert.equal(
    Buffer.from(header.slice('http.extraheader='.length).replace('Authorization: Basic ', ''), 'base64').toString(),
    'x-access-token:example-token',
  )
  assert.ok(!args.some((arg) => arg.includes('https://')))
})

test('resolveSourceAuths resolves only the sources that declare auth, keyed by source id', async () => {
  const config = {
    sources: [
      { kind: 'git', id: 'private-plugins', url: 'https://github.invalid/x.git', auth: { credential: 'demo-token' } },
      { kind: 'path', id: 'open-plugins', path: './plugins' },
    ],
    plugins: {},
  } as unknown as WorkbenchConfig
  const auths = await resolveSourceAuths(config, { configDir: '/config', credentials: consumer({ 'demo-token': TOKEN }) })
  assert.deepEqual([...auths.keys()], [sourceId(config.sources[0]!, '/config')])
  assert.equal(auths.get(sourceId(config.sources[0]!, '/config'))?.ok, true)
})

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
import test from 'node:test'
import { gitAuthArgs, resolveSourceAuth, resolveSourceAuths } from '../src/source-auth.ts'
import { redactArgs, sourceId } from '../src/sources.ts'
import type { CredentialConsumer, CredentialRef, CredentialResolution, GitAuthHandler } from '../src/credentials/definition.ts'
import type { WorkbenchConfig } from '../src/types.ts'

/** A fake value: never a real credential, and asserted to be non-leaking below. */
const TOKEN = 'example-token-value-never-a-real-secret'
const APP_KEY_REF = 'example-app-key'
/** A fake App private key (never a real key): the VALUE a git auth handler receives. */
const PRIVATE_KEY = 'example-app-private-key-value-never-a-real-secret'

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

/**
 * The SAME consumer, plus the git auth lookup a PLUGIN registers on the live
 * service: the core only dispatches by `auth.type`, so a test handler is enough
 * to prove the dispatch (and that no minting code is needed in the core).
 */
function consumerWithGitAuth(values: Record<string, string>, handlers: GitAuthHandler[]): CredentialConsumer {
  const base = consumer(values)
  const byType = new Map(handlers.map((handler) => [handler.type, handler]))
  return {
    ...base,
    gitAuth: (type: string) => byType.get(type),
    gitAuthTypes: () => [...byType.keys()].sort(),
  }
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

test('source auth (non-builtin type): the resolved value goes to the PLUGIN-registered git auth handler', async () => {
  const seen: { auth: Record<string, unknown>; value: string }[] = []
  const handler: GitAuthHandler = {
    type: 'github-app',
    args(request) {
      seen.push({ auth: request.auth, value: request.value })
      // A handler mints / formats from the VALUE it received in memory only.
      return gitAuthArgs('ghs_example_installation_token')
    },
  }
  const auth = await resolveSourceAuth(
    { credential: APP_KEY_REF, type: 'github-app', appId: 3967918, installationId: 138119822 },
    { credentials: consumerWithGitAuth({ [APP_KEY_REF]: PRIVATE_KEY }, [handler]) },
  )
  assert.equal(auth.ok, true)
  assert.ok(auth.ok)
  assert.match(auth.mechanism, /via the 'github-app' git auth handler/)
  assert.equal(auth.credential, APP_KEY_REF)
  assert.equal(auth.provider, 'fixture')
  assert.equal(seen.length, 1)
  // The handler got the credential VALUE plus the source `auth` block (names/ids only).
  assert.equal(seen[0]!.value, PRIVATE_KEY)
  assert.equal(seen[0]!.auth.appId, 3967918)
  assert.equal(seen[0]!.auth.installationId, 138119822)
  // The core adds NOTHING of its own: the args are exactly what the plugin returned.
  assert.deepEqual(auth.args, gitAuthArgs('ghs_example_installation_token'))
  // The credential VALUE (the App key) never reaches the git arguments.
  assert.ok(!auth.args.some((arg) => arg.includes(PRIVATE_KEY)))
})

test('source auth: an auth.type no plugin provides fails loudly, naming the type (no core fallback)', async () => {
  const auth = await resolveSourceAuth(
    { credential: APP_KEY_REF, type: 'github-app' },
    { credentials: consumerWithGitAuth({ [APP_KEY_REF]: PRIVATE_KEY }, []) },
  )
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /'github-app'/)
  assert.match(auth.error, /core ships NO backend/)
  assert.match(auth.error, /credentials-github-app/)
  assert.match(auth.error, /Registered types: \(none\)/)
})

test('source auth: a git auth handler that throws is reported, never swallowed', async () => {
  const handler: GitAuthHandler = {
    type: 'github-app',
    args() {
      throw new Error('the App key is not a valid PEM')
    },
  }
  const auth = await resolveSourceAuth(
    { credential: APP_KEY_REF, type: 'github-app' },
    { credentials: consumerWithGitAuth({ [APP_KEY_REF]: PRIVATE_KEY }, [handler]) },
  )
  assert.equal(auth.ok, false)
  assert.ok(!auth.ok)
  assert.match(auth.error, /example-app-key/)
  assert.match(auth.error, /not a valid PEM/)
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

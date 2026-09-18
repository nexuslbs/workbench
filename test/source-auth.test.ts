/**
 * SOURCE AUTH tests: a private `git` source is fetched with a credential that is
 * resolved by the BOOTSTRAP set (no plugin loaded) and used TRANSIENTLY.
 *
 * Everything here runs against LOCAL git repositories and a STUB GitHub API, so
 * the suite needs no network and no real secret. The values used are obvious
 * fakes.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
// Through the package entry: only the composition root (src/index.ts,
// src/kernel.ts) may name a concrete provider, which is what the seam check
// enforces - a test is a consumer like any other.
import { bootstrapCredentials } from '../src/index.ts'
import {
  clearInstallationTokenCache,
  githubAppJwt,
  resolveSourceAuth,
  resolveSourceAuths,
} from '../src/source-auth.ts'
import { redactArgs, resolveSource } from '../src/sources.ts'
import type { SourceSpec } from '../src/types.ts'

const TOKEN = 'wb-fake-token-0123456789'
const BASIC = Buffer.from(`x-access-token:${TOKEN}`, 'utf8').toString('base64')

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_AUTHOR_NAME: 'workbench-test',
    GIT_AUTHOR_EMAIL: 'test@workbench.local',
    GIT_COMMITTER_NAME: 'workbench-test',
    GIT_COMMITTER_EMAIL: 'test@workbench.local',
    GIT_TERMINAL_PROMPT: '0',
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf8' })
}

/** A local "remote" holding one plugin, so no test touches the network. */
function makeRemote(root: string): string {
  const origin = path.join(root, 'origin')
  fs.mkdirSync(path.join(origin, 'plugins', 'hello-private'), { recursive: true })
  fs.writeFileSync(
    path.join(origin, 'plugins', 'hello-private', 'workbench.plugin.json'),
    JSON.stringify({ name: 'hello-private', version: '0.0.1', entry: 'index.ts' }),
  )
  fs.writeFileSync(path.join(origin, 'plugins', 'hello-private', 'index.ts'), 'export default { name: "hello-private", apply: () => {} }\n')
  git(origin, ['init', '--quiet', '-b', 'main'])
  git(origin, ['add', '.'])
  git(origin, ['-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'hello-private'])
  return origin
}

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-source-auth-'))
}

function specFor(origin: string, auth: SourceSpec['auth']): SourceSpec {
  return {
    kind: 'git',
    id: 'private-local',
    url: `file://${origin}`,
    ref: 'main',
    ...(auth === undefined ? {} : { auth }),
  }
}

test('source auth: a token credential is resolved by the bootstrap set and the fetch succeeds', async () => {
  const root = tmpRoot()
  const origin = makeRemote(root)
  const cache = path.join(root, 'cache')
  process.env.WB_TEST_SOURCE_TOKEN = TOKEN
  // No plugin is loaded here: the bootstrap set is core providers only.
  const credentials = bootstrapCredentials({ configDir: root })
  assert.deepEqual(credentials.enabled(), ['env', 'file', 'project-env', 'user-env'])

  const auth = await resolveSourceAuth({ type: 'token', credential: 'WB_TEST_SOURCE_TOKEN' }, { credentials })
  assert.equal(auth.ok, true)
  if (!auth.ok) return
  assert.equal(auth.provider, 'env')
  assert.equal(auth.credential, 'WB_TEST_SOURCE_TOKEN')
  const rendered = auth.args.join(' ') // prettier-ignore
  assert.match(rendered, /-c credential\.helper= /)
  assert.match(rendered, new RegExp(`http\\.extraheader=Authorization: Basic ${BASIC}`))

  const spec = specFor(origin, { type: 'token', credential: 'WB_TEST_SOURCE_TOKEN' })
  const resolved = resolveSource(spec, root, cache, auth)
  assert.equal(resolved.error, undefined)
  assert.ok(resolved.dir !== null)
  assert.ok(fs.existsSync(path.join(resolved.dir as string, 'plugins', 'hello-private', 'workbench.plugin.json')))

  // NOTHING persisted: no token in the checkout config, no credential file, and
  // the remote url is exactly the configured one.
  const config = fs.readFileSync(path.join(resolved.dir as string, '.git', 'config'), 'utf8')
  assert.ok(!config.includes(TOKEN), 'the token must not be persisted in .git/config')
  assert.ok(!config.includes(BASIC), 'the auth header must not be persisted in .git/config')
  assert.match(config, /url = file:\/\//)
  assert.equal(fs.existsSync(path.join(resolved.dir as string, '.git-credentials')), false)

  // The UPDATE path (in-place fetch of the same ref) works with the same auth.
  const second = resolveSource(spec, root, cache, auth)
  assert.equal(second.error, undefined)
  assert.equal(second.dir, resolved.dir)
})

test('source auth: a missing credential fails loudly, names the source, and never serves a stale checkout', async () => {
  const root = tmpRoot()
  const origin = makeRemote(root)
  const cache = path.join(root, 'cache')
  const credentials = bootstrapCredentials({ configDir: root })
  const spec = specFor(origin, { type: 'token', credential: 'WB_TEST_ABSENT' })

  const auth = await resolveSourceAuth({ type: 'token', credential: 'WB_TEST_ABSENT' }, { credentials })
  assert.equal(auth.ok, false)
  if (auth.ok) return
  assert.match(auth.error, /WB_TEST_ABSENT/)

  // A stale checkout from an earlier run exists: it must NOT be served.
  const stale = path.join(cache, 'private-local')
  fs.mkdirSync(path.join(stale, '.git'), { recursive: true })
  fs.mkdirSync(path.join(stale, 'plugins', 'hello-private'), { recursive: true })

  const resolved = resolveSource(spec, root, cache, auth)
  assert.equal(resolved.dir, null)
  assert.match(resolved.error as string, /source 'private-local' \(git file:.* @ main\): authentication failed/)
  assert.match(resolved.error as string, /WB_TEST_ABSENT/)

  // No auth outcome at all: a source that declares auth is never fetched anonymously.
  const anonymous = resolveSource(spec, root, cache)
  assert.equal(anonymous.dir, null)
  assert.match(anonymous.error as string, /declares 'auth' but no credential was resolved/)
})

test('source auth: resolution is per source id, and a broken source never hides the others', async () => {
  const root = tmpRoot()
  const origin = makeRemote(root)
  process.env.WB_TEST_SOURCE_TOKEN = TOKEN
  const credentials = bootstrapCredentials({ configDir: root })
  const config = {
    sources: [
      specFor(origin, { type: 'token', credential: 'WB_TEST_SOURCE_TOKEN' }),
      { kind: 'git' as const, id: 'broken', url: `file://${path.join(root, 'nope')}`, ref: 'main', auth: { credential: 'WB_TEST_ABSENT' } },
    ],
  }
  const auths = await resolveSourceAuths(config as never, { configDir: root, credentials })
  assert.deepEqual([...auths.keys()], ['private-local', 'broken'])
  assert.equal(auths.get('private-local')?.ok, true)
  assert.equal(auths.get('broken')?.ok, false)

  const good = resolveSource(config.sources[0], root, path.join(root, 'cache'), auths.get('private-local'))
  assert.equal(good.error, undefined)
  const broken = resolveSource(config.sources[1], root, path.join(root, 'cache'), auths.get('broken'))
  assert.equal(broken.dir, null)
  assert.match(broken.error as string, /source 'broken'/)
})

test('source auth: a failing git command never echoes the token', async () => {
  const root = tmpRoot()
  process.env.WB_TEST_SOURCE_TOKEN = TOKEN
  const credentials = bootstrapCredentials({ configDir: root })
  const auth = await resolveSourceAuth({ type: 'token', credential: 'WB_TEST_SOURCE_TOKEN' }, { credentials })
  assert.equal(auth.ok, true)
  if (!auth.ok) return
  const spec = specFor(path.join(root, 'does-not-exist'), { type: 'token', credential: 'WB_TEST_SOURCE_TOKEN' })
  const resolved = resolveSource(spec, root, path.join(root, 'cache'), auth)
  assert.equal(resolved.dir, null)
  const error = resolved.error as string
  assert.match(error, /source 'private-local'/)
  assert.match(error, /http\.extraheader=<redacted>/)
  assert.ok(!error.includes(TOKEN))
  assert.ok(!error.includes(BASIC))
  assert.deepEqual(redactArgs(['-c', 'http.extraheader=Authorization: Basic abc']), ['-c', 'http.extraheader=<redacted>'])
})

test('github-app: RS256 JWT + installation token minted through the documented REST flow', async () => {
  const root = tmpRoot()
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  process.env.WB_TEST_APP_KEY = privateKey

  const jwt = githubAppJwt({ appId: 3967918, privateKey, now: 1_000_000 })
  const [header, claims, signature] = jwt.split('.')
  assert.equal(JSON.parse(Buffer.from(header, 'base64url').toString('utf8')).alg, 'RS256')
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')).iss, '3967918')
  assert.equal(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')).exp, 1540)
  assert.ok((signature as string).length > 100)

  clearInstallationTokenCache()
  let calls = 0
  const fetchImpl = (async (url: string | URL, init: RequestInit) => {
    calls += 1
    assert.match(String(url), /\/app\/installations\/138119822\/access_token$/)
    const headers = (init.headers ?? {}) as Record<string, string>
    assert.match(headers.authorization as string, /^Bearer eyJ/)
    return new Response(JSON.stringify({ token: 'ghs_fakeInstallationToken', expires_at: new Date(Date.now() + 3600_000).toISOString() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch

  const credentials = bootstrapCredentials({ configDir: root })
  const authSpec = { type: 'github-app' as const, credential: 'WB_TEST_APP_KEY', appId: 3967918, installationId: 138119822 }
  const auth = await resolveSourceAuth(authSpec, { credentials, fetchImpl })
  assert.equal(auth.ok, true)
  if (!auth.ok) return
  assert.match(auth.mechanism, /github-app installation token/)
  assert.ok(!auth.args.join(' ').includes('ghs_fakeInstallationToken'), 'the minted token must not appear in clear text in the git args')

  // A second resolution reuses the cached token (long-running serve: one mint per hour, not per fetch).
  const second = await resolveSourceAuth(authSpec, { credentials, fetchImpl })
  assert.equal(second.ok, true)
  assert.equal(calls, 1)

  // A minting failure names the status and never the key.
  const failing = (async () => new Response(JSON.stringify({ message: 'Bad credentials' }), { status: 401 })) as unknown as typeof fetch
  const bad = await resolveSourceAuth({ ...authSpec, appId: 1234, installationId: 5678 }, { credentials, fetchImpl: failing })
  assert.equal(bad.ok, false)
  if (bad.ok) return
  assert.match(bad.error, /HTTP 401/)
  assert.ok(!bad.error.includes(privateKey.slice(0, 60)))
})

test('bootstrap set: only core providers can be selected, and a plugin id is a loud error', () => {
  const root = tmpRoot()
  assert.deepEqual(bootstrapCredentials({ configDir: root, providers: ['file'] }).enabled(), ['file'])
  assert.throws(() => bootstrapCredentials({ configDir: root, providers: ['vault'] }), /is not a CORE provider/)
  assert.throws(() => bootstrapCredentials({ configDir: root, providers: ['env', 'env'] }), /listed twice/)
})

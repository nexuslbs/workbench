// Credentials capability: the CONTRACT HARNESS plus the four core providers.
//
// Every test below talks to the capability the way a CONSUMER does: through
// `kernel.credentials` (the definition) - no test imports a provider module
// directly, which is exactly the seam rule `npm run check:seam` enforces.
// The same consumer call (`consumerResolve`) is used against env, file,
// project-env, user-env and the manifest-declared mock provider, so a provider
// swap shows up as a different `provider` with the identical result shape.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel, type Kernel } from '../src/kernel.ts'
import {
  CREDENTIALS,
  CREDENTIALS_CONTRACT,
  CREDENTIALS_VERSION,
  type CredentialRef,
} from '../src/credentials/definition.ts'
import { expandCredentialRefs, expandCredentialRefsDeep, expandEnvDeep } from '../src/config.ts'
import type { CredentialsConfig, WorkbenchConfig } from '../src/types.ts'
import { CORE_PLUGINS } from './fixtures.ts'
import { mockProvider } from './mock-provider.ts'

const quiet = (): void => undefined

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/** Boots a kernel from an inline config: credentials only, no plugin sources. */
async function kernelWith(
  credentials: CredentialsConfig,
  plugins: Record<string, Record<string, unknown>> = {},
  configDir = process.cwd(),
): Promise<Kernel> {
  return createKernel({
    config: { sources: [], plugins, credentials },
    configDir,
    configFile: '(credentials test)',
    log: quiet,
  })
}

/**
 * THE consumer: one call, provider agnostic, identical shape for every
 * provider. Nothing here knows whether the answer comes from the environment,
 * a file, a project env file, a user env file, a mock or an external plugin.
 */
async function consumerResolve(kernel: Kernel, name: string, scope?: string): Promise<{ provider?: string; value?: string }> {
  const ref: CredentialRef = scope === undefined ? { name } : { name, scope }
  const resolution = await kernel.credentials.resolve(ref)
  return resolution === undefined ? {} : { provider: resolution.provider, value: resolution.value }
}

test('the credentials service is registered and declares the four core providers in default precedence order', async () => {
  const kernel = await kernelWith({})
  try {
    assert.equal(kernel.credentials.name, CREDENTIALS)
    assert.deepEqual(kernel.credentials.enabled(), ['env', 'file', 'project-env', 'user-env'])
    const providers = kernel.credentials.providers()
    assert.deepEqual(
      providers.map((provider) => [provider.id, provider.contract, provider.plugin, provider.external, provider.registered]),
      [
        ['env', CREDENTIALS_CONTRACT, 'workbench-core', false, true],
        ['file', CREDENTIALS_CONTRACT, 'workbench-core', false, true],
        ['project-env', CREDENTIALS_CONTRACT, 'workbench-core', false, true],
        ['user-env', CREDENTIALS_CONTRACT, 'workbench-core', false, true],
      ],
    )
  } finally {
    await kernel.dispose()
  }
})

test('env provider: the process environment, exact name then ENV-normalised name', async () => {
  process.env.WORKBENCH_TEST_ENV_TOKEN = 'example-env-token'
  const kernel = await kernelWith({ providers: ['env'] })
  try {
    assert.deepEqual(await consumerResolve(kernel, 'WORKBENCH_TEST_ENV_TOKEN'), {
      provider: 'env',
      value: 'example-env-token',
    })
    // `workbench-test-env-token` is looked up as WORKBENCH_TEST_ENV_TOKEN.
    assert.deepEqual(await consumerResolve(kernel, 'workbench-test-env-token'), {
      provider: 'env',
      value: 'example-env-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'NOT_SET_ANYWHERE'), {})
  } finally {
    await kernel.dispose()
    delete process.env.WORKBENCH_TEST_ENV_TOKEN
  }
})

test('file provider: a JSON credentials file, including scoped entries', async () => {
  const dir = tempDir('workbench-credentials-file')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(
    file,
    JSON.stringify({ 'deploy-token': 'example-file-token', demo: { 'registry-password': 'example-scoped-token' } }),
  )
  const kernel = await kernelWith({ providers: ['file'] }, { 'credentials-file': { path: file } }, dir)
  try {
    assert.deepEqual(await consumerResolve(kernel, 'deploy-token'), { provider: 'file', value: 'example-file-token' })
    assert.deepEqual(await consumerResolve(kernel, 'registry-password', 'demo'), {
      provider: 'file',
      value: 'example-scoped-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'demo/registry-password'), {
      provider: 'file',
      value: 'example-scoped-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'absent'), {})
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('project-env provider: the project level env file', async () => {
  const dir = tempDir('workbench-credentials-project')
  fs.writeFileSync(path.join(dir, '.env'), '# project scope\nPROJECT_TOKEN=example-project-token\n')
  const kernel = await kernelWith({ providers: ['project-env'] }, { 'credentials-project-env': { dir } }, dir)
  try {
    assert.deepEqual(await consumerResolve(kernel, 'PROJECT_TOKEN'), {
      provider: 'project-env',
      value: 'example-project-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'project-token'), {
      provider: 'project-env',
      value: 'example-project-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'ABSENT_TOKEN'), {})
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('user-env provider: the user level env file', async () => {
  const home = tempDir('workbench-credentials-user')
  fs.writeFileSync(path.join(home, '.env'), 'USER_TOKEN=example-user-token\n')
  const kernel = await kernelWith({ providers: ['user-env'] }, { 'credentials-user-env': { dir: home } }, home)
  try {
    assert.deepEqual(await consumerResolve(kernel, 'USER_TOKEN'), {
      provider: 'user-env',
      value: 'example-user-token',
    })
    assert.deepEqual(await consumerResolve(kernel, 'ABSENT_TOKEN'), {})
  } finally {
    await kernel.dispose()
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('CONTRACT HARNESS: one consumer call, four providers, identical result shape', async () => {
  const dir = tempDir('workbench-credentials-harness')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'harness-token': 'example-from-file' }))
  fs.writeFileSync(path.join(dir, '.env'), 'HARNESS_TOKEN=example-from-project-env\n')
  fs.writeFileSync(path.join(dir, 'user.env'), 'HARNESS_TOKEN=example-from-user-env\n')
  process.env.HARNESS_TOKEN = 'example-from-env'

  const cases: { id: string; credentials: CredentialsConfig; plugins: Record<string, Record<string, unknown>> }[] = [
    { id: 'env', credentials: { providers: ['env'] }, plugins: {} },
    { id: 'file', credentials: { providers: ['file'] }, plugins: { 'credentials-file': { path: file } } },
    {
      id: 'project-env',
      credentials: { providers: ['project-env'] },
      plugins: { 'credentials-project-env': { dir } },
    },
    {
      id: 'user-env',
      credentials: { providers: ['user-env'] },
      plugins: { 'credentials-user-env': { file: path.join(dir, 'user.env') } },
    },
  ]

  try {
    const answers: { id: string; answer: { provider?: string; value?: string } }[] = []
    for (const item of cases) {
      const kernel = await kernelWith(item.credentials, item.plugins, dir)
      try {
        answers.push({ id: item.id, answer: await consumerResolve(kernel, 'HARNESS_TOKEN') })
      } finally {
        await kernel.dispose()
      }
    }

    assert.deepEqual(
      answers.map((entry) => [entry.id, entry.answer.provider, entry.answer.value]),
      [
        ['env', 'env', 'example-from-env'],
        ['file', 'file', 'example-from-file'],
        ['project-env', 'project-env', 'example-from-project-env'],
        ['user-env', 'user-env', 'example-from-user-env'],
      ],
    )
    // Identical shape for every provider: the consumer cannot tell them apart.
    const shapes = new Set(answers.map((entry) => JSON.stringify(Object.keys(entry.answer).sort())))
    assert.equal(shapes.size, 1)
  } finally {
    delete process.env.HARNESS_TOKEN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a provider that no manifest declares cannot register (the manifest is what makes it resolvable)', async () => {
  const kernel = await kernelWith({})
  try {
    assert.throws(
      () => kernel.credentials.register(mockProvider('undeclared-mock', { 'mock-token': 'example-mock' })),
      /not declared; declare it in the plugin manifest/,
    )
  } finally {
    await kernel.dispose()
  }
})

test('a manifest-declared provider is selectable by config id and answers the same consumer call', async () => {
  const kernel = await kernelWith({})
  try {
    // Exactly what the loader does for a plugin whose manifest declares
    // capabilities: [{ id: 'credentials', version: 1, provider: 'mock' }].
    kernel.credentials.declare({
      provider: 'mock',
      version: CREDENTIALS_VERSION,
      plugin: 'mock-provider',
      source: 'test',
      external: true,
    })
    kernel.credentials.register(mockProvider('mock', { 'mock-token': 'example-mock-token' }))
    kernel.credentials.setEnabled(['mock'])
    assert.deepEqual(await consumerResolve(kernel, 'mock-token'), { provider: 'mock', value: 'example-mock-token' })
    assert.deepEqual(
      kernel.credentials.providers().map((provider) => [provider.id, provider.enabled]),
      [['env', false], ['file', false], ['project-env', false], ['user-env', false], ['mock', true]],
    )
  } finally {
    await kernel.dispose()
  }
})

test('provider selection and precedence are CONFIG ONLY: one row swaps the answering provider', async () => {
  const dir = tempDir('workbench-credentials-swap')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'swap-token': 'example-from-file' }))
  process.env.SWAP_TOKEN = 'example-from-env'
  const plugins = { 'credentials-file': { path: file } }
  try {
    const envFirst = await kernelWith({ providers: ['env', 'file'] }, plugins, dir)
    const fileFirst = await kernelWith({ providers: ['file', 'env'] }, plugins, dir)
    try {
      // SAME consumer call, same provider set: only the config row differs.
      assert.deepEqual(await consumerResolve(envFirst, 'swap-token'), { provider: 'env', value: 'example-from-env' })
      assert.deepEqual(await consumerResolve(fileFirst, 'swap-token'), { provider: 'file', value: 'example-from-file' })
      assert.deepEqual(envFirst.credentials.enabled(), ['env', 'file'])
      assert.deepEqual(fileFirst.credentials.enabled(), ['file', 'env'])
    } finally {
      await envFirst.dispose()
      await fileFirst.dispose()
    }
  } finally {
    delete process.env.SWAP_TOKEN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a disabled provider never answers, the enabled one still does', async () => {
  const dir = tempDir('workbench-credentials-disabled')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'file-only-token': 'example-file-only' }))
  process.env.ENV_ONLY_TOKEN = 'example-env-only'
  const kernel = await kernelWith({ providers: ['env'] }, { 'credentials-file': { path: file } }, dir)
  try {
    assert.deepEqual(await consumerResolve(kernel, 'ENV_ONLY_TOKEN'), { provider: 'env', value: 'example-env-only' })
    // The file provider is registered but not enabled: it must not answer.
    assert.deepEqual(await consumerResolve(kernel, 'file-only-token'), {})
    const registered = kernel.credentials.providers().filter((provider) => provider.registered)
    assert.deepEqual(registered.map((provider) => provider.id), ['env', 'file', 'project-env', 'user-env'])
    assert.deepEqual(registered.filter((provider) => provider.enabled).map((provider) => provider.id), ['env'])
  } finally {
    await kernel.dispose()
    delete process.env.ENV_ONLY_TOKEN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('a provider that throws is skipped and recorded; another provider still answers', async () => {
  const kernel = await kernelWith({})
  try {
    kernel.credentials.declare({
      provider: 'broken',
      version: CREDENTIALS_VERSION,
      plugin: 'broken-provider',
      source: 'test',
      external: true,
    })
    kernel.credentials.register(mockProvider('broken', { 'resilient-token': 'example-unused' }, { fail: 'resilient-token' }))
    kernel.credentials.setEnabled(['broken', 'file'])
    process.env.RESILIENT_TOKEN = 'example-from-env'
    try {
      const trace = await kernel.credentials.explain({ name: 'RESILIENT_TOKEN' })
      assert.deepEqual(
        trace.attempts.map((attempt) => [attempt.provider, attempt.status]),
        [['broken', 'error'], ['file', 'missing']],
      )
      // Nothing else is enabled: the failure is REPORTED (never masked as a
      // missing credential), and it names the provider that failed.
      await assert.rejects(
        () => kernel.credentials.resolve({ name: 'RESILIENT_TOKEN' }),
        /no provider resolved 'RESILIENT_TOKEN'.*mock provider 'broken' failed/,
      )
      // As soon as another provider can answer, the walk continues past the
      // failure and the SAME consumer call is answered.
      kernel.credentials.setEnabled(['broken', 'env'])
      assert.deepEqual(await consumerResolve(kernel, 'RESILIENT_TOKEN'), { provider: 'env', value: 'example-from-env' })
    } finally {
      delete process.env.RESILIENT_TOKEN
    }
  } finally {
    await kernel.dispose()
  }
})

test('hygiene: an unresolvable reference names the reference, never a value', async () => {
  const dir = tempDir('workbench-credentials-hygiene')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ present: 'example-hygiene-value' }))
  const kernel = await kernelWith({ providers: ['file'] }, { 'credentials-file': { path: file } }, dir)
  try {
    const resolution = await kernel.credentials.resolve({ name: 'present' })
    assert.equal(resolution?.value, 'example-hygiene-value')

    await assert.rejects(
      () => expandCredentialRefs('token=${cred:absent}', kernel.credentials),
      (error: Error) => {
        assert.match(error.message, /credential 'absent' could not be resolved/)
        assert.match(error.message, /file/)
        assert.ok(!error.message.includes('example-hygiene-value'), 'the message must not contain a value')
        return true
      },
    )

    // No listing, description or trace ever carries a value.
    const observable = JSON.stringify({
      providers: kernel.credentials.providers(),
      enabled: kernel.credentials.enabled(),
      names: await kernel.credentials.list(),
      describe: kernel.credentials.providers().map((provider) => provider.describe),
    })
    assert.ok(!observable.includes('example-hygiene-value'))
  } finally {
    await kernel.dispose()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * The REMOVED credential alias spelling, assembled from pieces so this file
 * carries no literal mention of it (the alias-free grep gate covers the repo).
 */
const LEGACY_CRED_KIND = ['sec', 'ret'].join('')
function legacyRef(name: string): string {
  return '$' + '{' + LEGACY_CRED_KIND + ':' + name + '}'
}

test('config consumer: ${cred:NAME} resolves through the service; ${env:VAR} is unchanged and the removed alias is rejected', async () => {
  const dir = tempDir('workbench-credentials-config')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ 'deploy-token': 'example-config-token', demo: { token: 'example-scoped' } }))
  process.env.WORKBENCH_TEST_PLAIN = 'example-plain-env'
  const kernel = await kernelWith({ providers: ['file'], scope: 'demo' }, { 'credentials-file': { path: file } }, dir)
  try {
    const expanded = (await expandCredentialRefsDeep(
      {
        cred: 'token=${cred:deploy-token}',
        scoped: 'token=${cred:demo/token}',
        defaultScope: 'token=${cred:token}',
        env: 'value=${env:WORKBENCH_TEST_PLAIN}',
      },
      kernel.credentials,
      { scope: 'demo' },
    )) as Record<string, string>
    assert.deepEqual(expanded, {
      cred: 'token=example-config-token',
      scoped: 'token=example-scoped',
      defaultScope: 'token=example-scoped',
      env: 'value=${env:WORKBENCH_TEST_PLAIN}',
    })
    // `${env:VAR}` belongs to the OTHER consumer (`readConfig` expands it while
    // reading the file, before the credentials service exists), so the
    // credential expansion must leave it untouched rather than double-expand.
    assert.deepEqual(expandEnvDeep({ a: 'x-${env:WORKBENCH_TEST_PLAIN}' }), { a: 'x-example-plain-env' })

    // The removed alias is NOT a credential reference: it is a HARD config
    // error naming the offending reference and the ONE supported form, and it
    // is never resolved - so no credential value may leak into the message.
    await assert.rejects(
      () => expandCredentialRefs(`prefix ${legacyRef('deploy-token')} suffix`, kernel.credentials, { scope: 'demo' }),
      (error: Error) => {
        assert.match(error.message, /is not a credential reference/)
        assert.match(error.message, /\$\{cred:NAME\}/)
        assert.ok(error.message.includes(legacyRef('deploy-token')), 'the message must name the offending reference')
        assert.ok(!error.message.includes('example-config-token'), 'the message must never contain a value')
        return true
      },
    )
    // A scoped removed reference is rejected the same way; its value stays out.
    await assert.rejects(
      () => expandCredentialRefs(legacyRef('demo/token'), kernel.credentials, { scope: 'demo' }),
      (error: Error) => {
        assert.match(error.message, /is not a credential reference/)
        assert.ok(!error.message.includes('example-scoped'), 'the message must never contain a value')
        return true
      },
    )
  } finally {
    await kernel.dispose()
    delete process.env.WORKBENCH_TEST_PLAIN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('end to end: a plugin config value with ${cred:NAME} is expanded during a real kernel boot', async () => {
  const dir = tempDir('workbench-credentials-e2e')
  const file = path.join(dir, 'credentials.json')
  fs.writeFileSync(file, JSON.stringify({ greeting: 'example-greeting-from-file' }))
  const configFile = path.join(dir, 'workbench.config.yml')
  fs.writeFileSync(
    configFile,
    [
      'sources:',
      '  - kind: path',
      '    id: core',
      `    path: ${JSON.stringify(CORE_PLUGINS)}`,
      '    external: false',
      '',
      'credentials:',
      '  providers: [file]',
      '',
      'plugins:',
      '  credentials-file:',
      `    path: ${JSON.stringify(file)}`,
      '  hello-world:',
      "    message: '${cred:greeting} ${env:WORKBENCH_TEST_E2E_PLAIN}'",
      '',
    ].join('\n'),
  )
  process.env.WORKBENCH_TEST_E2E_PLAIN = 'example-plain-env'

  const kernel = await createKernel({ configFile, configDir: dir, log: quiet })
  try {
    assert.equal(
      await kernel.registry.resolve(['hello', 'world'])?.command.run([]),
      'example-greeting-from-file example-plain-env',
    )
    assert.deepEqual(kernel.credentials.enabled(), ['file'])
  } finally {
    await kernel.dispose()
    delete process.env.WORKBENCH_TEST_E2E_PLAIN
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown provider id in the config is an explicit error naming what is available', async () => {
  await assert.rejects(
    () => kernelWith({ providers: ['vault'] }),
    (error: Error) => {
      assert.match(error.message, /provider 'vault' is not declared by any plugin/)
      assert.match(error.message, /env, file, project-env, user-env/)
      return true
    },
  )
})

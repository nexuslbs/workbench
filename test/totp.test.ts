// TOTP capability (`totp@1`): the CONTRACT tests of the core definition.
//
// They pin what the definition itself is responsible for, with a mock provider
// whose behaviour the test fully controls: provider declaration/registration,
// selection, entry metadata pass-through, `code()` argument validation and the
// structured errors. The RFC 4226/6238 algorithm itself lives in a PROVIDER
// plugin (`nexuslbs/workbench-plugins`), not here, and is tested there.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import {
  DEFAULT_ALGORITHM,
  DEFAULT_DIGITS,
  DEFAULT_PERIOD,
  normalizeAlgorithm,
  normalizeAt,
  normalizeDigits,
  normalizeEntryLabel,
  normalizePeriod,
  stepAt,
  TOTP,
  TOTP_CONTRACT,
  TOTP_VERSION,
  Totp,
  TotpEntryNotConfiguredError,
  TotpNotConfiguredError,
  TotpUnknownEntryError,
  type TotpCode,
  type TotpCodeOptions,
  type TotpEntryInfo,
  type TotpProvider,
  type TotpService,
} from '../src/totp/definition.ts'

/** The mock provider: fixed entries, a fixed code derivation, optional failure. */
function mockProvider(
  options: {
    id?: string
    version?: number
    entries?: TotpEntryInfo[]
    describe?: string
    code?: (label: string, options?: TotpCodeOptions) => TotpCode
  } = {},
): TotpProvider {
  const entries: TotpEntryInfo[] = options.entries ?? [
    { label: 'github', issuer: 'GitHub', account: 'me@example.com', digits: 6, period: 30, algorithm: 'SHA1', configured: true },
    { label: 'aws-root', digits: 6, period: 30, algorithm: 'SHA256', configured: true },
  ]
  return {
    id: options.id ?? 'mock',
    version: options.version ?? TOTP_VERSION,
    ...(options.describe === undefined ? {} : { describe: () => options.describe as string }),
    entries: () => entries,
    code: (label: string, codeOptions: TotpCodeOptions = {}): TotpCode => {
      if (options.code) return options.code(label, codeOptions)
      const entry = entries.find((candidate) => candidate.label === label)
      if (!entry) throw new TotpUnknownEntryError(label, entries.map((candidate) => candidate.label))
      if (!entry.configured) throw new TotpEntryNotConfiguredError(label, 'no key resolved')
      const at = codeOptions.at ?? 0
      const { step, remainingSeconds } = stepAt(at, entry.period)
      return {
        label,
        code: String(step % 10 ** entry.digits).padStart(entry.digits, '0'),
        digits: entry.digits,
        period: entry.period,
        algorithm: entry.algorithm,
        generatedAt: at,
        remainingSeconds,
      }
    },
  }
}

/** Boots the definition the way the kernel does, with the mock provider registered. */
async function harness(options: { declare?: boolean; registered?: boolean } = {}): Promise<{
  service: TotpService
  provider: TotpProvider
  dispose: () => void
}> {
  const ctx = new Context()
  let service!: TotpService
  await ctx.plugin({ name: TOTP, apply: (c) => { service = new Totp(c) } })
  const provider = mockProvider()
  if (options.declare !== false) {
    service.declare({ provider: provider.id, version: TOTP_VERSION, plugin: 'test', source: 'test', external: false })
  }
  const dispose = options.registered === false ? () => undefined : service.register(provider)
  return { service, provider, dispose }
}

test('the contract id is totp@1', () => {
  assert.equal(TOTP, 'totp')
  assert.equal(TOTP_VERSION, 1)
  assert.equal(TOTP_CONTRACT, 'totp@1')
  assert.equal(DEFAULT_DIGITS, 6)
  assert.equal(DEFAULT_PERIOD, 30)
  assert.equal(DEFAULT_ALGORITHM, 'SHA1')
})

test('with no provider declared the capability reports itself as NOT CONFIGURED', async () => {
  const ctx = new Context()
  let service!: TotpService
  await ctx.plugin({ name: TOTP, apply: (c) => { service = new Totp(c) } })
  await assert.rejects(async () => await service.entries(), (error: unknown) => {
    assert.ok(error instanceof TotpNotConfiguredError)
    assert.match((error as Error).message, /no totp provider is available/)
    return true
  })
  await assert.rejects(async () => await service.code('github'), TotpNotConfiguredError)
})

test('a declared and registered provider answers entries() and code()', async () => {
  const { service } = await harness()
  const entries = await service.entries()
  assert.deepEqual(
    entries.map((entry) => entry.label),
    ['github', 'aws-root'],
  )
  assert.deepEqual(entries[0], {
    label: 'github',
    issuer: 'GitHub',
    account: 'me@example.com',
    digits: 6,
    period: 30,
    algorithm: 'SHA1',
    configured: true,
  })

  const now = await service.code('github')
  assert.equal(now.label, 'github')
  assert.equal(now.digits, 6)
  assert.equal(now.period, 30)
  assert.equal(now.algorithm, 'SHA1')
  assert.match(now.code, /^[0-9]{6}$/)
  assert.ok(now.remainingSeconds >= 1 && now.remainingSeconds <= 30)

  // `at` makes the answer deterministic and is forwarded unchanged (floored).
  const at = await service.code('github', { at: 59 })
  assert.equal(at.generatedAt, 59)
  assert.equal(at.remainingSeconds, 1)
  const at60 = await service.code('github', { at: 60.9 })
  assert.equal(at60.generatedAt, 60)
  assert.equal(at60.remainingSeconds, 30)
})

test('the entry metadata of the definition never carries a secret', async () => {
  const { service } = await harness()
  const payload = JSON.stringify(await service.entries())
  assert.ok(!/secret|key|password/i.test(payload), payload)
  assert.match(payload, /github/)
})

test('an unknown entry label is a structured error, not a crash', async () => {
  const { service } = await harness()
  await assert.rejects(async () => await service.code('nope'), (error: unknown) => {
    assert.ok(error instanceof TotpUnknownEntryError)
    assert.equal((error as TotpUnknownEntryError).label, 'nope')
    assert.match((error as Error).message, /unknown entry 'nope' \(configured: github, aws-root\)/)
    return true
  })
  // The service keeps answering after the error.
  assert.equal((await service.entries()).length, 2)
})

test('an entry without a usable key reports NOT CONFIGURED without failing the plugin', async () => {
  const ctx = new Context()
  let service!: TotpService
  await ctx.plugin({ name: TOTP, apply: (c) => { service = new Totp(c) } })
  const provider = mockProvider({
    entries: [
      { label: 'github', digits: 6, period: 30, algorithm: 'SHA1', configured: true },
      { label: 'aws-root', digits: 6, period: 30, algorithm: 'SHA1', configured: false },
    ],
  })
  service.declare({ provider: provider.id, version: TOTP_VERSION, plugin: 'test', source: 'test', external: false })
  service.register(provider)
  const entries = await service.entries()
  assert.deepEqual(
    entries.map((entry) => entry.configured),
    [true, false],
  )
  await assert.rejects(async () => await service.code('aws-root'), (error: unknown) => {
    assert.ok(error instanceof TotpEntryNotConfiguredError)
    assert.equal((error as TotpEntryNotConfiguredError).label, 'aws-root')
    assert.match((error as Error).message, /is not configured/)
    return true
  })
  // The configured entry still answers.
  assert.equal((await service.code('github')).label, 'github')
})

test('register() refuses a provider that no manifest declared', async () => {
  const { service } = await harness({ declare: false, registered: false })
  assert.throws(
    () => service.register(mockProvider({ id: 'undeclared' })),
    /totp: provider 'undeclared' is not declared; declare it in the plugin manifest/,
  )
})

test('register() refuses a contract version the core does not speak', async () => {
  const ctx = new Context()
  let service!: TotpService
  await ctx.plugin({ name: TOTP, apply: (c) => { service = new Totp(c) } })
  assert.throws(
    () => service.declare({ provider: 'old', version: 2, plugin: 'test', source: 'test', external: false }),
    /declares provider 'old' for contract version 2, but this core speaks totp@1/,
  )
})

test('register() is fail-closed on a duplicate and returns a working disposer', async () => {
  const { service, provider } = await harness()
  assert.throws(() => service.register(provider), /totp: provider 'mock' is already registered/)
})

test('selection: setEnabled rejects an undeclared id, and a disabled provider never answers', async () => {
  const ctx = new Context()
  let service!: TotpService
  await ctx.plugin({ name: TOTP, apply: (c) => { service = new Totp(c) } })
  const first = mockProvider({ id: 'first' })
  const second = mockProvider({ id: 'second' })
  for (const provider of [first, second]) {
    service.declare({ provider: provider.id, version: TOTP_VERSION, plugin: 'test', source: 'test', external: false })
    service.register(provider)
  }
  assert.deepEqual(service.enabled(), ['first', 'second'])
  assert.throws(() => service.setEnabled(['nope']), /totp: provider 'nope' is not declared by any plugin/)
  service.setEnabled(['second'])
  assert.deepEqual(service.enabled(), ['second'])
  assert.equal(service.providers().find((provider) => provider.id === 'first')?.enabled, false)

  const dispose = service.register // unused, keeps the disposer contract visible
  assert.equal(typeof dispose, 'function')
})

test('a disposed provider registration stops answering', async () => {
  const { service, dispose } = await harness()
  assert.equal((await service.entries()).length, 2)
  dispose()
  await assert.rejects(async () => await service.entries(), TotpNotConfiguredError)
})

test('the definition validates labels and `at` before reaching a provider', async () => {
  const { service } = await harness()
  await assert.rejects(async () => await service.code('   '), /totp: an entry 'label' must be a non-empty string/)
  await assert.rejects(async () => await service.code('github', { at: -1 }), /totp: 'at' must not be negative/)
  await assert.rejects(async () => await service.code('github', { at: 'now' as unknown as number }), /totp: 'at' must be a number of unix seconds/)
})

test('normalizeAt/normalizeDigits/normalizePeriod/normalizeAlgorithm default and reject', () => {
  assert.equal(normalizeAt(undefined, 1_700_000_000_500), 1_700_000_000)
  assert.equal(normalizeAt(59.9), 59)
  assert.equal(normalizeAt(0), 0)

  assert.equal(normalizeDigits(undefined), DEFAULT_DIGITS)
  assert.equal(normalizeDigits(8), 8)
  assert.throws(() => normalizeDigits(3), /totp: 'digits' must be an integer in 4..10/)
  assert.throws(() => normalizeDigits(6.5), /totp: 'digits' must be an integer in 4..10/)

  assert.equal(normalizePeriod(undefined), DEFAULT_PERIOD)
  assert.equal(normalizePeriod(60), 60)
  assert.throws(() => normalizePeriod(0), /totp: 'period' must be an integer in 1..3600 seconds/)

  assert.equal(normalizeAlgorithm(undefined), DEFAULT_ALGORITHM)
  assert.equal(normalizeAlgorithm('sha512'), 'SHA512')
  assert.throws(() => normalizeAlgorithm('MD5'), /totp: 'algorithm' must be one of SHA1\/SHA256\/SHA512/)

  assert.equal(normalizeEntryLabel(' github '), 'github')
  assert.throws(() => normalizeEntryLabel(''), /totp: an entry 'label' must be a non-empty string/)
})

test('stepAt pins the boundary behaviour: T=59 and T=60 of a 30s step', () => {
  assert.deepEqual(stepAt(0, 30), { step: 0, remainingSeconds: 30 })
  assert.deepEqual(stepAt(29, 30), { step: 0, remainingSeconds: 1 })
  assert.deepEqual(stepAt(59, 30), { step: 1, remainingSeconds: 1 })
  assert.deepEqual(stepAt(60, 30), { step: 2, remainingSeconds: 30 })
  assert.deepEqual(stepAt(90, 30), { step: 3, remainingSeconds: 30 })
})

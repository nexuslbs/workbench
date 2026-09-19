// SMS capability (`sms@1`): the CONTRACT tests of the core definition.
//
// They pin what the definition itself is responsible for, with a mock provider
// whose behaviour the test fully controls: provider declaration/registration,
// selection, number metadata pass-through, the list/get argument validation,
// the code-extraction heuristic and the structured errors. The Twilio REST
// transport lives in a PROVIDER plugin (`nexuslbs/workbench-plugins`), not here,
// and is tested there.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from 'cordis'
import {
  capBody,
  DEFAULT_CODE_OCCURRENCES,
  SMS_CODE_PATTERN,
  SMS_DEFAULT_LIST_LIMIT,
  extractSmsCode,
  extractCodes,
  MAX_BODY_CHARS,
  MAX_CODE_OCCURRENCES,
  SMS_MAX_LIST_LIMIT,
  normalizeSmsLimit,
  normalizeNumberRef,
  normalizeOccurrences,
  SMS,
  SMS_CONTRACT,
  SMS_VERSION,
  Sms,
  SmsNotFoundError,
  SmsNotConfiguredError,
  SmsNumberNotConfiguredError,
  SmsUnknownNumberError,
  TRUNCATED_MARKER,
  type NumberRef,
  type SmsCode,
  type SmsCodeOptions,
  type SmsListOptions,
  type SmsMessage,
  type SmsNumber,
  type SmsProvider,
  type SmsSearchOptions,
  type SmsService,
  type SmsSummary,
} from '../src/sms/definition.ts'

const PERSONAL = '+15551234567'
const WORK = '+15557654321'

/** Two messages on the personal inbox, newest first, plus one on the work one. */
function defaultMessages(): SmsMessage[] {
  return [
    {
      id: 'SM1',
      from: '+15550001111',
      to: PERSONAL,
      date: '2026-09-19T10:00:00.000Z',
      body: 'Your verification code is 483920. Do not share it.',
      status: 'received',
      unread: true,
      segments: 1,
      direction: 'inbound',
    },
    {
      id: 'SM2',
      from: 'BankAlert',
      to: PERSONAL,
      date: '2026-09-19T09:00:00.000Z',
      body: 'No code here, just a notice.',
      status: 'received',
      unread: false,
    },
    {
      id: 'SW1',
      from: '+15550002222',
      to: WORK,
      date: '2026-09-19T08:00:00.000Z',
      body: 'Work inbox code 7F4K2Q expires in 5 minutes.',
      status: 'received',
      unread: true,
    },
  ]
}

/** The mock provider: fixed numbers/messages, controllable failures. */
function mockProvider(options: {
  id?: string
  version?: number
  numbers?: SmsNumber[]
  messages?: SmsMessage[]
  describe?: string
  code?: (ref: NumberRef | undefined, options: SmsCodeOptions) => SmsCode
  search?: (ref: NumberRef | undefined, query: string, options: SmsSearchOptions) => SmsSummary[]
} = {}): SmsProvider {
  const numbers: SmsNumber[] = options.numbers ?? [
    { label: 'personal', number: PERSONAL, default: true, configured: true },
    { label: 'work', number: WORK, configured: true },
  ]
  const messages = options.messages ?? defaultMessages()
  const known = (ref: NumberRef | undefined): SmsNumber => {
    const label = ref?.label ?? numbers.find((number) => number.default)?.label ?? numbers[0]?.label ?? ''
    const number = numbers.find((candidate) => candidate.label === label)
    if (!number) throw new SmsUnknownNumberError(label, numbers.map((candidate) => candidate.label))
    if (number.configured === false) throw new SmsNumberNotConfiguredError(label, "credential 'TWILIO_X' did not resolve")
    return number
  }
  return {
    id: options.id ?? 'mock',
    version: options.version ?? SMS_VERSION,
    ...(options.describe === undefined ? {} : { describe: () => options.describe as string }),
    numbers: () => numbers,
    list: (ref: NumberRef | undefined, listOptions: SmsListOptions): SmsSummary[] => {
      const number = known(ref)
      let found = messages.filter((message) => message.to === number.number)
      if (listOptions.since !== undefined) found = found.filter((message) => message.date >= (listOptions.since as string))
      if (listOptions.unreadOnly === true) found = found.filter((message) => message.unread === true)
      if (listOptions.from !== undefined) {
        const needle = listOptions.from.toLowerCase()
        found = found.filter((message) => message.from.toLowerCase().includes(needle))
      }
      return found.slice(0, listOptions.limit ?? SMS_DEFAULT_LIST_LIMIT)
    },
    get: (ref: NumberRef | undefined, id: string): SmsMessage => {
      known(ref)
      const message = messages.find((candidate) => candidate.id === id)
      if (!message) throw new SmsNotFoundError(`no message '${id}'`)
      return message
    },
    ...(options.code === undefined ? {} : { code: options.code }),
    ...(options.search === undefined ? {} : { search: options.search }),
  }
}

/** Boots the definition the way the kernel does, with the mock provider registered. */
async function harness(options: { declare?: boolean; registered?: boolean; provider?: SmsProvider } = {}): Promise<{
  service: SmsService
  provider: SmsProvider
  dispose: () => void
}> {
  const ctx = new Context()
  let service!: SmsService
  await ctx.plugin({ name: SMS, apply: (c) => { service = new Sms(c) } })
  const provider = options.provider ?? mockProvider()
  if (options.declare !== false) {
    service.declare({ provider: provider.id, version: SMS_VERSION, plugin: 'test', source: 'test', external: false })
  }
  const dispose = options.registered === false ? () => undefined : service.register(provider)
  return { service, provider, dispose }
}

test('the contract id is sms@1, with bounded list/scan defaults', () => {
  assert.equal(SMS, 'sms')
  assert.equal(SMS_VERSION, 1)
  assert.equal(SMS_CONTRACT, 'sms@1')
  assert.equal(SMS_DEFAULT_LIST_LIMIT, 10)
  assert.equal(SMS_MAX_LIST_LIMIT, 100)
  assert.equal(DEFAULT_CODE_OCCURRENCES, 1)
  assert.equal(MAX_BODY_CHARS, 2000)
})

test('with no provider declared the capability reports itself as NOT CONFIGURED', async () => {
  const ctx = new Context()
  let service!: SmsService
  await ctx.plugin({ name: SMS, apply: (c) => { service = new Sms(c) } })
  for (const call of [
    () => service.numbers(),
    () => service.list(),
    () => service.get(undefined, 'SM1'),
    () => service.code(),
    () => service.search(undefined, 'code'),
  ]) {
    await assert.rejects(async () => await call(), (error: unknown) => {
      assert.ok(error instanceof SmsNotConfiguredError)
      assert.match((error as Error).message, /no sms provider is available/)
      return true
    })
  }
})

test('numbers() reports labels/metadata only, list() answers the DEFAULT number when none is named', async () => {
  const { service } = await harness()
  const numbers = await service.numbers()
  assert.deepEqual(
    numbers.map((number) => number.label),
    ['personal', 'work'],
  )
  assert.equal(numbers[0]?.default, true)
  assert.equal(numbers[0]?.number, PERSONAL)
  const listed = await service.list()
  assert.deepEqual(
    listed.map((message) => message.id),
    ['SM1', 'SM2'],
    'the default number is the personal inbox',
  )
  const work = await service.list({ label: 'work' })
  assert.deepEqual(
    work.map((message) => message.id),
    ['SW1'],
  )
  assert.equal(listed[0]?.body.includes('483920'), true)
})

test('list() forwards limit/since/from/unreadOnly and caps the limit at the contract maximum', async () => {
  const seen: SmsListOptions[] = []
  const provider = mockProvider()
  const original = provider.list
  provider.list = (ref, options) => {
    seen.push(options)
    return original(ref, options)
  }
  const { service } = await harness({ provider })
  await service.list(undefined, { limit: 5, since: '2026-09-19T09:30:00.000Z', from: '+1555000', unreadOnly: true })
  assert.equal(seen[0]?.limit, 5)
  assert.equal(seen[0]?.since, '2026-09-19T09:30:00.000Z')
  assert.equal(seen[0]?.from, '+1555000')
  assert.equal(seen[0]?.unreadOnly, true)
  await service.list(undefined, { limit: 10_000 })
  assert.equal(seen[1]?.limit, SMS_MAX_LIST_LIMIT, 'a caller cannot ask for more than the hard cap')
  await assert.rejects(async () => await service.list(undefined, { limit: 0 }), /'limit' must be a positive integer/)
  await assert.rejects(async () => await service.list(undefined, { limit: 'x' as unknown as number }), /'limit' must be a number/)
})

test('a body longer than the contract cap is truncated, and a provider body is capped too', async () => {
  const long = `${'x'.repeat(MAX_BODY_CHARS + 500)}`
  const { service } = await harness({ provider: mockProvider({ messages: [{ id: 'LONG', from: '+1', to: PERSONAL, date: '2026-09-19T10:00:00.000Z', body: long }] }) })
  const listed = await service.list()
  assert.equal(listed[0]?.body.length, MAX_BODY_CHARS + TRUNCATED_MARKER.length)
  assert.equal(listed[0]?.body.endsWith(TRUNCATED_MARKER), true)
  const one = await service.get(undefined, 'LONG')
  assert.equal(one.body.endsWith(TRUNCATED_MARKER), true)
  assert.equal(capBody('short'), 'short')
  assert.equal(capBody('', 3), '')
  assert.equal(capBody(undefined), '')
})

test('get() needs a non-empty id and answers the full message with its metadata', async () => {
  const { service } = await harness()
  await assert.rejects(async () => await service.get(undefined, '   '), /get\(\) needs a non-empty message 'id'/)
  const message = await service.get(undefined, 'SM1')
  assert.equal(message.id, 'SM1')
  assert.equal(message.from, '+15550001111')
  assert.equal(message.to, PERSONAL)
  assert.equal(message.segments, 1)
  assert.equal(message.direction, 'inbound')
  assert.equal(message.body.includes('483920'), true)
})

test('code() extracts the digits-first code from the NEWEST message by default', async () => {
  const { service } = await harness()
  const extracted = await service.code()
  assert.deepEqual(extracted, {
    code: '483920',
    body: 'Your verification code is 483920. Do not share it.',
    from: '+15550001111',
    date: '2026-09-19T10:00:00.000Z',
    messageId: 'SM1',
  })
  // The work inbox carries an alphanumeric code: the fallback finds it.
  const work = await service.code({ label: 'work' })
  assert.equal(work.code, '7F4K2Q')
  assert.equal(work.messageId, 'SW1')
})

test('code() honours id, query, pattern, occurrences and maxAgeSeconds', async () => {
  const { service } = await harness()
  // id short-circuits the scan, even for the message without a code.
  await assert.rejects(async () => await service.code(undefined, { id: 'SM2' }), (error: unknown) => {
    assert.ok(error instanceof SmsNotFoundError)
    assert.match((error as Error).message, /no code found in 1 message\(s\) of \(default\)/)
    return true
  })
  // query keeps only matching senders/bodies; that message carries no code, so
  // the filtered scan fails instead of falling back to another sender.
  await assert.rejects(async () => await service.code(undefined, { query: 'BankAlert' }), SmsNotFoundError)
  await assert.rejects(async () => await service.code(undefined, { query: 'no such sender' }), SmsNotFoundError)
  // An explicit pattern overrides the default shape (this one pulls a word).
  const notice = await service.code(undefined, { query: 'BankAlert', pattern: 'notice' })
  assert.equal(notice.code, 'notice')
  // An explicit pattern overrides the default shape, on a named number too.
  const work = await service.code({ label: 'work' }, { pattern: 'code ([A-Za-z0-9]{6})' })
  assert.equal(work.code, '7F4K2Q')
  // occurrences picks the Nth candidate of a body carrying several.
  const multi = await harness({
    provider: mockProvider({
      messages: [{ id: 'M1', from: '+1', to: PERSONAL, date: '2026-09-19T10:00:00.000Z', body: 'code 111111 then 222222' }],
    }),
  })
  assert.equal((await multi.service.code()).code, '111111')
  assert.equal((await multi.service.code(undefined, { occurrences: 2 })).code, '222222')
  await assert.rejects(async () => await multi.service.code(undefined, { occurrences: 3 }), /no code found/)
  await assert.rejects(async () => await multi.service.code(undefined, { occurrences: 0 }), /'occurrences' must be an integer in 1\.\.20/)
  // maxAgeSeconds is a window over the message DATE: one message dated now,
  // one a day old - only the recent one is scanned.
  const now = Date.now()
  const clocked = await harness({
    provider: mockProvider({
      messages: [
        { id: 'C1', from: '+1', to: PERSONAL, date: new Date(now).toISOString(), body: 'code 424242' },
        { id: 'C2', from: '+2', to: PERSONAL, date: new Date(now - 86_400_000).toISOString(), body: 'code 111111' },
      ],
    }),
  })
  assert.equal((await clocked.service.code(undefined, { maxAgeSeconds: 3600 })).code, '424242')
  // A window that excludes every message scans nothing (a structured error).
  const stale = await harness({
    provider: mockProvider({
      messages: [{ id: 'C3', from: '+3', to: PERSONAL, date: new Date(now - 86_400_000).toISOString(), body: 'code 999999' }],
    }),
  })
  await assert.rejects(async () => await stale.service.code(undefined, { maxAgeSeconds: 3600 }), /no code found in 0 message\(s\)/)
  // An invalid pattern is a real error, never a silent no-match.
  await assert.rejects(async () => await service.code(undefined, { pattern: '(' }), /invalid 'pattern'/)
})

test('search() filters the newest messages on sender/body when the provider has no native search', async () => {
  const { service } = await harness()
  const found = await service.search(undefined, 'bankalert')
  assert.deepEqual(
    found.map((message) => message.id),
    ['SM2'],
  )
  const byBody = await service.search(undefined, '483920')
  assert.deepEqual(
    byBody.map((message) => message.id),
    ['SM1'],
  )
  assert.deepEqual(await service.search(undefined, 'nothing here'), [])
  await assert.rejects(async () => await service.search(undefined, '  '), /search\(\) needs a non-empty 'query'/)
})

test('a provider with a NATIVE code()/search() answers instead of the definition heuristics', async () => {
  const calls: string[] = []
  const { service } = await harness({
    provider: mockProvider({
      code: (_ref: NumberRef | undefined, options: SmsCodeOptions) => {
        calls.push(`code:${options.pattern ?? '(default)'}`)
        return { code: 'NATIVE', body: 'from the provider', from: '+1', date: '2026-09-19T00:00:00.000Z', messageId: 'N1' }
      },
      search: (_ref: NumberRef | undefined, query: string) => {
        calls.push(`search:${query}`)
        return [{ id: 'N2', from: '+2', to: PERSONAL, date: '2026-09-19T00:00:00.000Z', body: 'native' }]
      },
    }),
  })
  assert.equal((await service.code()).code, 'NATIVE')
  assert.deepEqual(
    (await service.search(undefined, 'hello')).map((message) => message.id),
    ['N2'],
  )
  assert.deepEqual(calls, ['code:(default)', 'search:hello'])
})

test('provider selection: first ENABLED and registered provider answers; unknown/duplicate ids are config errors', async () => {
  const ctx = new Context()
  let service!: SmsService
  await ctx.plugin({ name: SMS, apply: (c) => { service = new Sms(c) } })
  const first = mockProvider({ id: 'first', describe: 'first backend' })
  const second = mockProvider({ id: 'second', messages: [{ id: 'S9', from: '+9', to: PERSONAL, date: '2026-09-19T10:00:00.000Z', body: 'code 999999' }] })
  for (const provider of [first, second]) {
    service.declare({ provider: provider.id, version: SMS_VERSION, plugin: `plugin-${provider.id}`, source: 'test', external: false })
    service.register(provider)
  }
  assert.deepEqual(service.enabled(), ['first', 'second'], 'absent selection enables every declared provider in order')
  assert.deepEqual(
    (await service.list()).map((message) => message.id),
    ['SM1', 'SM2'],
  )
  assert.equal(service.providers().find((info) => info.id === 'first')?.describe, 'first backend')
  // Precedence is configuration: the second provider wins once it is first.
  service.setEnabled(['second'])
  assert.deepEqual(
    (await service.list()).map((message) => message.id),
    ['S9'],
  )
  assert.deepEqual(
    service.providers().map((info) => `${info.id}:${String(info.enabled)}:${String(info.registered)}`),
    ['first:false:true', 'second:true:true'],
  )
  assert.throws(() => service.setEnabled(['nope']), /provider 'nope' is not declared by any plugin \(available: first, second\)/)
  assert.throws(() => service.setEnabled(['first', 'first']), /listed twice/)
  // Disabling every REGISTERED provider is not possible through selection
  // (empty means "every declared provider"), but unregistering does it.
  service.setEnabled([])
  // Registering an id that is already registered is refused (one implementation
  // per provider id); the existing registration stays in place.
  assert.throws(() => service.register(mockProvider({ id: 'first' })), /already registered/)
  assert.equal(service.providers().filter((info) => info.registered).length, 2)
})

test('declare()/register() enforce the manifest contract: declared id, sms@1 version, one implementation', async () => {
  const { service } = await harness({ declare: false, registered: false })
  assert.throws(() => service.register(mockProvider()), /provider 'mock' is not declared/)
  service.declare({ provider: 'mock', version: SMS_VERSION, plugin: 'test', source: 'test', external: false })
  assert.throws(
    () => service.declare({ provider: 'mock', version: SMS_VERSION, plugin: 'another', source: 'test', external: true }),
    /declared twice/,
  )
  // The same plugin redeclaring its own id is a no-op (a plugin may be re-applied).
  service.declare({ provider: 'mock', version: SMS_VERSION, plugin: 'test', source: 'test', external: false })
  assert.throws(
    () => service.declare({ provider: 'other', version: 2, plugin: 'test', source: 'test', external: false }),
    /declares provider 'other' for contract version 2, but this core speaks sms@1/,
  )
  assert.throws(() => service.register({ id: 'x', version: SMS_VERSION, numbers: () => [], list: () => [], get: () => ({}) as never }), /is not declared/)
  const dispose = service.register(mockProvider())
  assert.equal(service.providers().filter((info) => info.registered).length, 1)
  dispose()
  assert.equal(service.providers()[0]?.registered, false)
  assert.throws(() => service.register(mockProvider({ version: 2 })), /implements contract version 2/)
})

test('an unknown number label and an unconfigured number surface as structured errors', async () => {
  const { service } = await harness({ provider: mockProvider({ numbers: [
    { label: 'personal', number: PERSONAL, default: true, configured: true },
    { label: 'work', number: WORK, configured: false },
  ] }) })
  await assert.rejects(async () => await service.list({ label: 'nope' }), (error: unknown) => {
    assert.ok(error instanceof SmsUnknownNumberError)
    assert.equal((error as SmsUnknownNumberError).label, 'nope')
    assert.match((error as Error).message, /unknown number 'nope' \(configured: personal, work\)/)
    return true
  })
  await assert.rejects(async () => await service.list({ label: 'work' }), (error: unknown) => {
    assert.ok(error instanceof SmsNumberNotConfiguredError)
    assert.match((error as Error).message, /number 'work' is not configured \(credential 'TWILIO_X' did not resolve\)/)
    return true
  })
  // The capability keeps serving the healthy number after the failures.
  assert.equal((await service.list()).length, 2)
})

test('normalizeNumberRef/normalizeSmsLimit/normalizeOccurrences validate their inputs', () => {
  assert.equal(normalizeNumberRef(undefined), undefined)
  assert.deepEqual(normalizeNumberRef({ label: ' work ' }), { label: 'work' })
  assert.throws(() => normalizeNumberRef({ label: '  ' }), /number reference needs a non-empty label/)
  assert.throws(() => normalizeNumberRef({ label: 3 } as unknown as NumberRef), /number reference needs a non-empty label/)
  assert.equal(normalizeSmsLimit(undefined), SMS_DEFAULT_LIST_LIMIT)
  assert.equal(normalizeSmsLimit(3.7), 3)
  assert.equal(normalizeSmsLimit(5000), SMS_MAX_LIST_LIMIT)
  assert.equal(normalizeOccurrences(undefined), 1)
  assert.equal(normalizeOccurrences(2), 2)
  assert.throws(() => normalizeOccurrences(1.5), /'occurrences' must be an integer/)
})

test('the code heuristic: digits-first 4-8, alphanumeric fallback, no plain word', () => {
  assert.equal(extractSmsCode('Your code is 483920'), '483920')
  assert.equal(extractSmsCode('pin 1234 please'), '1234')
  assert.equal(extractSmsCode('code 12345678 ok'), '12345678')
  assert.equal(extractSmsCode('code 123456789 ok'), undefined, '9 digits is not the default shape')
  assert.equal(extractSmsCode('code 7F4K2Q'), '7F4K2Q')
  assert.equal(extractSmsCode('code ABCDEF'), undefined, 'a word without a digit is not a code')
  assert.equal(extractSmsCode('code 123456'), '123456')
  assert.equal(extractSmsCode('nothing'), undefined)
  assert.equal(extractSmsCode(undefined), undefined)
  assert.equal(extractSmsCode('serial X4839201'), 'X4839201', 'an isolated alphanumeric token is a candidate')
  assert.equal(extractSmsCode('serial X48392011'), undefined, 'a 9-character token is not the default shape')
  assert.equal(extractSmsCode('a-12B3', '(\\d{2})([A-Z]\\d)'), '12', 'group 1 wins when the pattern has one')
  assert.deepEqual(extractCodes('11111 22222 33333'), ['11111', '22222', '33333'])
  assert.equal(extractSmsCode('11111 22222', undefined, 2), '22222')
  assert.equal(SMS_CODE_PATTERN.includes('(?<![A-Za-z0-9])'), true, 'the default is delimited, not a bare digit run')
})

// Email capability (`email@1`): the CONTRACT HARNESS plus the manifest-declared
// provider boot path.
//
// Every test below talks to the capability the way a CONSUMER does: through
// `kernel.email` (the definition) - no test imports a provider module and no
// test reaches into provider internals, which is exactly the seam rule
// `npm run check:seam` enforces. The same consumer calls run against two
// different fake providers (declared through the same Definition), so a
// provider swap shows up as different data with an identical result shape.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createKernel, type Kernel } from '../src/kernel.ts'
import {
  EMAIL,
  EMAIL_CONTRACT,
  EMAIL_VERSION,
  MAX_LIST_LIMIT,
  EmailNotFoundError,
  EmailNotConfiguredError,
  EmailUnknownAccountError,
  accountLabel,
  extractCode,
  normalizeLimit,
  type EmailAccount,
  type EmailCodeOptions,
  type EmailGetOptions,
  type EmailListOptions,
  type EmailMessage,
  type EmailProvider,
  type EmailSummary,
} from '../src/email/definition.ts'
import type { EmailConfig } from '../src/types.ts'

const quiet = (): void => undefined

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`))
}

/** Boots a kernel from an inline config: no plugin sources unless given. */
async function kernelWith(email: EmailConfig, configDir = process.cwd()): Promise<Kernel> {
  return createKernel({
    config: { sources: [], email },
    configDir,
    configFile: '(email test)',
    log: quiet,
  })
}

interface FakeMessage {
  id: string
  subject: string
  from: string
  to: string[]
  date: string
  unread: boolean
  snippet?: string
  text: string
}

function ago(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString()
}

/**
 * A fake provider: in-memory mailboxes, no backend at all. It only implements
 * the three REQUIRED methods; `code`/`search` are left to the definition, which
 * is what makes the definition's own algorithm observable.
 */
function fakeProvider(id: string, prefix = ''): EmailProvider {
  const mailboxes: Record<string, FakeMessage[]> = {
    personal: [
      {
        id: '42',
        subject: `${prefix}Weekly digest`,
        from: 'news@example.com',
        to: ['me@example.com'],
        date: ago(300),
        unread: true,
        snippet: 'nothing to do',
        text: 'Nothing to see here, no numbers either.',
      },
      {
        id: '41',
        subject: `${prefix}Your login code`,
        from: 'security@example.com',
        to: ['me@example.com'],
        date: ago(2 * 24 * 3600),
        unread: false,
        text: 'Your login code is 998877',
      },
      {
        id: '40',
        subject: `${prefix}Old sign-in`,
        from: 'security@example.com',
        to: ['me@example.com'],
        date: ago(3 * 24 * 3600),
        unread: false,
        text: 'Enter 4F7K2Q to continue',
      },
    ],
    work: [
      {
        id: '7',
        subject: `${prefix}Work OTP`,
        from: 'it@work.example',
        to: ['me@work.example'],
        date: ago(600),
        unread: true,
        text: 'The code is 123456',
      },
    ],
  }

  const accounts: EmailAccount[] = [
    { label: 'personal', address: 'me@example.com', default: true, description: `${id} fake mailbox` },
    { label: 'work', address: 'me@work.example' },
  ]

  const mailbox = (ref: { label?: string } | undefined): FakeMessage[] => {
    const label = ref?.label ?? 'personal'
    const messages = mailboxes[label]
    if (!messages) throw new EmailUnknownAccountError(label, accounts.map((account) => account.label))
    return messages
  }

  const summary = (message: FakeMessage): EmailSummary => ({
    id: message.id,
    subject: message.subject,
    from: message.from,
    to: message.to,
    date: message.date,
    unread: message.unread,
    ...(message.snippet === undefined ? {} : { snippet: message.snippet }),
    folder: 'INBOX',
  })

  return {
    id,
    version: EMAIL_VERSION,
    describe: () => `fake backend '${id}'`,
    accounts: () => accounts,
    list: async (ref, options: EmailListOptions = {}) => mailbox(ref)
      .filter((message) => (options.unreadOnly === true ? message.unread : true))
      .filter((message) => (options.since === undefined ? true : message.date >= options.since))
      .slice(0, options.limit ?? 10)
      .map(summary),
    get: async (ref, id: string, options: EmailGetOptions = {}): Promise<EmailMessage> => {
      const messages = mailbox(ref)
      const message = messages.find((candidate) => candidate.id === id)
      if (!message) throw new EmailNotFoundError(`no message '${id}' in ${accountLabel(ref)}`)
      const format = options.format ?? 'text'
      return {
        ...summary(message),
        ...(format === 'text' ? { text: message.text } : {}),
        ...(format === 'markdown' ? { markdown: message.text } : {}),
        ...(format === 'html' ? { html: `<p>${message.text}</p>` } : {}),
        ...(format === 'raw' ? { raw: `Subject: ${message.subject}\r\n\r\n${message.text}` } : {}),
        attachments: [],
        format,
      }
    },
  }
}

/** Declares + registers a fake provider the way a plugin would. */
function useProvider(kernel: Kernel, provider: EmailProvider): void {
  kernel.email.declare({
    provider: provider.id,
    version: provider.version,
    plugin: `${provider.id}-fixture`,
    source: 'test',
    external: true,
  })
  kernel.email.register(provider)
}

test('the definition speaks email@1 and names no backend', async () => {
  assert.equal(EMAIL, 'email')
  assert.equal(EMAIL_VERSION, 1)
  assert.equal(EMAIL_CONTRACT, 'email@1')
  const source = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'email', 'definition.ts'), 'utf8')
  for (const backend of ['himalaya', 'imap', 'smtp', 'gmail', 'pop3', 'microsoft', 'graph']) {
    assert.equal(
      new RegExp(backend, 'i').test(source),
      false,
      `the email definition must not name the backend '${backend}'`,
    )
  }
})

test('the code pattern and the code extractor cover the usual OTP shapes', () => {
  assert.equal(extractCode('Your verification code is 123456'), '123456')
  assert.equal(extractCode('code: 4F7K2Q (expires soon)'), '4F7K2Q')
  assert.equal(extractCode('no code in here'), undefined)
  assert.equal(extractCode('order 1234567890123 shipped'), undefined, 'a long digit run is not an OTP')
  assert.equal(extractCode('order #4821 shipped'), '4821', '4-8 digits inside a word-ish context still counts')
  assert.equal(extractCode('code 12ab34', '([0-9]{2}[a-z]{2}[0-9]{2})'), '12ab34', 'an explicit pattern wins')
})

test('limits are normalised and capped by the definition', () => {
  assert.equal(normalizeLimit(undefined), 10)
  assert.equal(normalizeLimit(3), 3)
  assert.equal(normalizeLimit(10_000), MAX_LIST_LIMIT)
  assert.throws(() => normalizeLimit(0), /positive integer/)
  assert.throws(() => normalizeLimit('many'), /must be a number/)
})

test('an email provider is declared through the manifest and then answers the consumer calls', async () => {
  const dir = tempDir('workbench-email-boot')
  const sourceDir = path.join(dir, 'plugins', 'email-fake')
  fs.mkdirSync(sourceDir, { recursive: true })
  fs.writeFileSync(
    path.join(sourceDir, 'workbench.plugin.json'),
    JSON.stringify(
      {
        name: 'email-fake',
        version: '0.0.1',
        description: 'test fixture: a plugin declaring the email provider fake',
        entry: 'index.js',
        capabilities: [{ id: 'email', version: 1, provider: 'fake' }],
      },
      null,
      2,
    ) + '\n',
  )
  fs.writeFileSync(
    path.join(sourceDir, 'index.js'),
    `export function apply(ctx) {
  ctx.effect(() => ctx.email.register({
    id: 'fake',
    version: 1,
    describe: () => 'e2e fixture provider',
    accounts: () => [{ label: 'inbox', address: 'fixture@example.com', default: true }],
    list: () => [{ id: '1', subject: 'fixture message', from: 'from@example.com', to: ['fixture@example.com'], date: new Date().toISOString(), unread: true }],
    get: (_ref, id) => ({ id, subject: 'fixture message', from: 'from@example.com', to: ['fixture@example.com'], date: new Date().toISOString(), unread: false, text: 'The code is 246810', attachments: [], format: 'text' }),
  }))
}
export default { name: 'email-fake', inject: ['email'], apply }
`,
  )

  const kernel = await createKernel({
    config: {
      sources: [{ kind: 'path', id: 'plugins', path: path.join(dir, 'plugins'), external: true }],
      plugins: { 'email-fake': {} },
      email: { providers: ['fake'] },
    },
    configDir: dir,
    configFile: '(email boot test)',
    log: quiet,
  })
  try {
    assert.deepEqual(kernel.failures, [])
    assert.ok(kernel.plugins.some((plugin) => plugin.name === 'email-fake'))
    const providers = kernel.email.providers()
    assert.equal(providers.length, 1)
    assert.deepEqual(
      { id: providers[0]?.id, contract: providers[0]?.contract, enabled: providers[0]?.enabled, registered: providers[0]?.registered, external: providers[0]?.external },
      { id: 'fake', contract: 'email@1', enabled: true, registered: true, external: true },
    )
    // The manifest declaration is what made the registration legal: the plugin
    // never called declare() itself.
    assert.deepEqual(await kernel.email.accounts(), [
      { label: 'inbox', address: 'fixture@example.com', default: true },
    ])
    assert.equal((await kernel.email.list())[0]?.subject, 'fixture message')
    assert.equal((await kernel.email.get(undefined, '1')).text, 'The code is 246810')
    assert.equal((await kernel.email.code(undefined)).code, '246810')
  } finally {
    await kernel.dispose()
  }
})

test('a consumer call answers through the default account, an explicit label and the definition algorithm', async () => {
  const kernel = await kernelWith({})
  try {
    useProvider(kernel, fakeProvider('fake'))
    assert.deepEqual(kernel.failures, [])

    // accounts(): the labels, the addresses and the default flag - never a value.
    const accounts = await kernel.email.accounts()
    assert.deepEqual(accounts, [
      { label: 'personal', address: 'me@example.com', default: true, description: 'fake fake mailbox' },
      { label: 'work', address: 'me@work.example' },
    ])
    assert.equal(JSON.stringify(accounts).includes('password'), false)

    // list(): the default account when the ref is omitted, the named account otherwise.
    assert.deepEqual((await kernel.email.list()).map((message) => message.id), ['42', '41', '40'])
    assert.deepEqual((await kernel.email.list({ label: 'work' })).map((message) => message.id), ['7'])
    assert.deepEqual((await kernel.email.list(undefined, { unreadOnly: true })).map((m) => m.id), ['42'])
    assert.deepEqual((await kernel.email.list(undefined, { limit: 1 })).map((m) => m.id), ['42'])
    assert.deepEqual((await kernel.email.list(undefined, { since: ago(3600) })).map((m) => m.id), ['42'])
    assert.deepEqual((await kernel.email.list(undefined, { limit: 9999 })).length, 3, 'the limit is capped, not rejected')

    // get(): one message, envelope + body, format honoured.
    const message = await kernel.email.get({ label: 'work' }, '7')
    assert.equal(message.subject, 'Work OTP')
    assert.equal(message.text, 'The code is 123456')
    assert.equal(message.format, 'text')
    assert.deepEqual(message.attachments, [])
    assert.equal((await kernel.email.get(undefined, '40', { format: 'raw' })).raw?.includes('4F7K2Q'), true)

    // code(): the definition's own algorithm (the fake provider does not implement code()).
    const code = await kernel.email.code(undefined)
    assert.deepEqual(
      { code: code.code, subject: code.subject, messageId: code.messageId },
      { code: '998877', subject: 'Your login code', messageId: '41' },
    )
    assert.equal((await kernel.email.code(undefined, { id: '40' })).code, '4F7K2Q')
    assert.equal((await kernel.email.code(undefined, { query: 'sign-in' })).code, '4F7K2Q')
    assert.equal((await kernel.email.code({ label: 'work' }, { pattern: '([0-9]{6})' })).code, '123456')
    await assert.rejects(
      kernel.email.code(undefined, { pattern: '([0-9]{3}-[0-9]{3})' }),
      (error: unknown) => error instanceof EmailNotFoundError,
      'a pattern that matches nothing reports not-found, it does not invent a code',
    )
  } finally {
    await kernel.dispose()
  }
})

test('code() only scans recent messages when maxAgeSeconds is given', async () => {
  const kernel = await kernelWith({})
  try {
    useProvider(kernel, fakeProvider('fake'))
    assert.equal((await kernel.email.code(undefined)).code, '998877', 'the newest code message wins by default')
    await assert.rejects(
      kernel.email.code(undefined, { maxAgeSeconds: 3600 }),
      (error: unknown) => error instanceof EmailNotFoundError,
      'the only message inside the window carries no code',
    )
    assert.equal((await kernel.email.code(undefined, { maxAgeSeconds: 3 * 24 * 3600, pattern: '([0-9]{4,8})' })).code, '998877')
  } finally {
    await kernel.dispose()
  }
})

test('search() filters the newest messages when the provider has no native search', async () => {
  const kernel = await kernelWith({})
  try {
    useProvider(kernel, fakeProvider('fake'))
    assert.deepEqual((await kernel.email.search(undefined, 'digest')).map((message) => message.id), ['42'])
    assert.deepEqual((await kernel.email.search(undefined, 'security@example.com')).map((message) => message.id), ['41', '40'])
    assert.deepEqual(await kernel.email.search(undefined, 'nothing-matches'), [])
  } finally {
    await kernel.dispose()
  }
})

test('a provider that implements code()/search() natively is used instead of the algorithm', async () => {
  const kernel = await kernelWith({})
  try {
    const provider = fakeProvider('native')
    provider.code = async (_ref?: unknown, options?: EmailCodeOptions) => ({
      code: options?.pattern ?? 'NATIVE',
      subject: 'native',
      from: 'native@example.com',
      date: ago(1),
      messageId: '0',
    })
    provider.search = async () => []
    useProvider(kernel, provider)
    assert.equal((await kernel.email.code(undefined)).code, 'NATIVE')
    assert.deepEqual(await kernel.email.search(undefined, 'digest'), [])
  } finally {
    await kernel.dispose()
  }
})

test('an unknown account label is a typed error naming the configured labels, never a secret', async () => {
  const kernel = await kernelWith({})
  try {
    useProvider(kernel, fakeProvider('fake'))
    await assert.rejects(
      kernel.email.list({ label: 'missing' }),
      (error: unknown) =>
        error instanceof EmailUnknownAccountError &&
        error.label === 'missing' &&
        error.message.includes('personal, work'),
    )
  } finally {
    await kernel.dispose()
  }
})

test('without a registered provider the capability is NOT CONFIGURED, not broken', async () => {
  const declared = await kernelWith({})
  try {
    // A declared provider that never registered (an unconfigured plugin) is not
    // a crash either: the call reports the capability as not configured.
    declared.email.declare({ provider: 'himalaya', version: 1, plugin: 'email-himalaya', source: 'plugins', external: true })
    assert.deepEqual(
      declared.email.providers().map((provider) => ({ id: provider.id, registered: provider.registered })),
      [{ id: 'himalaya', registered: false }],
    )
    await assert.rejects(declared.email.accounts(), (error: unknown) => error instanceof EmailNotConfiguredError)
    await assert.rejects(declared.email.list(), (error: unknown) => error instanceof EmailNotConfiguredError)
    await assert.rejects(declared.email.code(undefined), (error: unknown) => error instanceof EmailNotConfiguredError)
  } finally {
    await declared.dispose()
  }

  const empty = await kernelWith({})
  try {
    await assert.rejects(empty.email.list(), (error: unknown) => error instanceof EmailNotConfiguredError)
  } finally {
    await empty.dispose()
  }
})

test('swap the enabled provider and the same consumer call answers from the other backend', async () => {
  // Two providers, both declared through the same Definition; only the config row
  // decides which one answers. The consumer code below is identical.
  const results: string[] = []
  for (const enabled of ['alpha', 'beta']) {
    const kernel = await kernelWith({})
    try {
      useProvider(kernel, fakeProvider('alpha', '[alpha] '))
      useProvider(kernel, fakeProvider('beta', '[beta] '))
      kernel.email.setEnabled([enabled])
      assert.deepEqual(kernel.email.enabled(), [enabled])
      const messages = await kernel.email.list({ label: 'work' })
      results.push(`${enabled} -> ${messages[0]?.subject}`)
    } finally {
      await kernel.dispose()
    }
  }
  assert.deepEqual(results, ['alpha -> [alpha] Work OTP', 'beta -> [beta] Work OTP'])
})

test('declare()/register() are fail-closed: version, duplicate id, undeclared id', async () => {
  const kernel = await kernelWith({})
  try {
    assert.throws(
      () => kernel.email.declare({ provider: 'old', version: 0, plugin: 'p', source: 's', external: true }),
      /contract version 0/,
    )
    useProvider(kernel, fakeProvider('fake'))
    assert.throws(
      () => kernel.email.declare({ provider: 'fake', version: 1, plugin: 'other', source: 's', external: true }),
      /declared twice/,
    )
    assert.throws(() => kernel.email.register(fakeProvider('fake')), /already registered/)
    assert.throws(() => kernel.email.register(fakeProvider('undeclared')), /is not declared/)
    assert.throws(
      () => kernel.email.register({ id: 'incomplete', version: 1 } as unknown as EmailProvider),
      /must implement accounts\(\), list\(\) and get\(\)/,
    )
  } finally {
    await kernel.dispose()
  }
})

test('the enabled provider list refuses an id no manifest declared', async () => {
  await assert.rejects(
    kernelWith({ providers: ['ghost'] }),
    /provider 'ghost' is not declared by any plugin/,
  )
})

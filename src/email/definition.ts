/**
 * Email capability - SERVICE DEFINITION.
 *
 * This module is the CONTRACT of the email capability and nothing else: it
 * names no mail backend, no protocol and no mail CLI - a provider owns those.
 * It exists so the three roles of the capability can evolve and be
 * replaced independently (`Provider -> Definition <- Consumer`, the same seam
 * the credentials and web capabilities use):
 *
 * - PROVIDERS (implementations, shipped by a plugin from any repository)
 *   implement {@link EmailProvider} and register themselves with the service.
 * - CONSUMERS (tool plugins, UI plugins, operators) only ever call
 *   `ctx.email`. A consumer never imports a provider; a provider never imports
 *   a consumer. `npm run check:seam` enforces that direction.
 *
 * What is NOT here on purpose:
 * - ACCOUNTS and CREDENTIALS. The definition knows account REFERENCES (a
 *   label such as `personal`), never an address and never a value; which
 *   accounts exist, and how a backend authenticates, is the provider's
 *   configuration. Credential VALUES come from the credentials capability
 *   (`ctx.credentials`) when a provider needs one.
 * - The notion of a "default" mailbox as a value: the default is a
 *   configuration decision the provider reports through
 *   {@link EmailAccount.default}, and the callers get by omitting the
 *   reference.
 *
 * An external provider is implementable from this module plus the docs alone
 * (`docs/PLUGIN-CONTRACT.md` section 4e): declare the capability in the plugin
 * manifest and register a descriptor implementing the contract version below.
 *
 * The `code()` (verification code extraction) and `search()` algorithms live
 * HERE, on top of `list()`/`get()`, because they are backend agnostic: a
 * provider that implements nothing but `accounts()`/`list()`/`get()` gets both
 * for free, and may override either one when its backend answers better.
 */
import { Service, type Context } from 'cordis'

/** Name of the cordis service (`ctx.email`). */
export const EMAIL = 'email'

/** Contract version this definition speaks. A provider must implement it. */
export const EMAIL_VERSION = 1

/** Contract id including the version, e.g. `email@1`. */
export const EMAIL_CONTRACT = `${EMAIL}@${EMAIL_VERSION}`

/** How many of the newest messages a `code()` call scans by default. */
export const DEFAULT_CODE_SCAN_LIMIT = 10

/** Default page size of a `list()` call when the caller passes no `limit`. */
export const DEFAULT_LIST_LIMIT = 10

/** Hard cap of a `list()` call, whatever the caller asks for. */
export const MAX_LIST_LIMIT = 100

/**
 * The default verification-code pattern: an OTP shape delimited by anything
 * that is not a letter/digit, either 4-8 DIGITS (`123456`) or a 6-8 character
 * ALPHANUMERIC code that carries at least one letter (`4F7K2Q`) - a bare
 * 4-8 digit run is the operator's `\b\d{4,8}\b`, extended with the alphanumeric
 * shapes one-time codes also use: 6-8 characters carrying BOTH a letter and a
 * digit (so a plain word never counts as a code). Callers override it with
 * `pattern`.
 */
export const DEFAULT_CODE_PATTERN =
  '(?<![A-Za-z0-9])(?:([0-9]{4,8})|(?=[A-Za-z0-9]*[A-Za-z])(?=[A-Za-z0-9]*[0-9])([A-Za-z0-9]{6,8}))(?![A-Za-z0-9])'

/**
 * A reference to a CONFIGURED account: a LABEL. It names a mailbox, it never
 * carries an address and it never carries a credential value; an omitted
 * reference means "the provider's default account".
 */
export interface AccountRef {
  /** Account label as configured (e.g. `personal`, `work`). */
  label: string
}

/** One configured account, as the provider reports it (never a secret). */
export interface EmailAccount {
  /** Account reference label. */
  label: string
  /** Email address, when the provider knows it (never a credential). */
  address?: string
  /** True for the account a call without a reference resolves to. */
  default?: boolean
  /** Provider's human description of the account/backend (never a value). */
  description?: string
}

/** The body format a caller asks a message in. */
export type EmailFormat = 'text' | 'markdown' | 'html' | 'raw'

/** `list()` options; every field is optional and bounded by the definition. */
export interface EmailListOptions {
  /** Mailbox folder (backend specific name, e.g. `INBOX`). */
  folder?: string
  /** How many of the newest messages. Default {@link DEFAULT_LIST_LIMIT}, capped at {@link MAX_LIST_LIMIT}. */
  limit?: number
  /** Only unread messages. */
  unreadOnly?: boolean
  /** ISO-8601 instant: only messages at/after it. */
  since?: string
}

/** One message envelope, as `list()`/`search()` report it. */
export interface EmailSummary {
  /** Backend message id (stable enough to be passed to `get()`). */
  id: string
  subject: string
  /** Display form of the sender, e.g. `Ada <ada@example.com>`. */
  from: string
  /** Display forms of the recipients. */
  to: string[]
  /** ISO-8601 instant (the provider normalises whatever the backend reports). */
  date: string
  unread: boolean
  /** Short body preview, when the backend offers one. */
  snippet?: string
  folder?: string
}

/** One attachment, as metadata only (the definition never carries its bytes). */
export interface EmailAttachment {
  filename: string
  contentType?: string
  /** Size in bytes, when the backend reports it. */
  size?: number
}

/** `get()` options. */
export interface EmailGetOptions {
  /** Body format to return (default `text`). */
  format?: EmailFormat
  /** Cap of the returned body/raw message, in bytes. */
  maxBytes?: number
}

/** One message: the envelope plus the body in the asked format. */
export interface EmailMessage extends EmailSummary {
  /** Plain text body (always returned unless the format is `html`/`raw`). */
  text?: string
  /** Markdown body, when the format asked for it and the backend has one. */
  markdown?: string
  /** HTML body, when the format asked for it. */
  html?: string
  /** The raw RFC822 message, when the format asked for it (bounded by `maxBytes`). */
  raw?: string
  attachments: EmailAttachment[]
  /** The format the body fields actually carry. */
  format: EmailFormat
}

/** `search()` options. */
export interface EmailSearchOptions {
  folder?: string
  limit?: number
}

/** `code()` options: which message to read, and how to extract the code. */
export interface EmailCodeOptions {
  /** Read THIS message instead of searching the newest ones. */
  id?: string
  /** Keep only messages whose subject/from/snippet contains this (case-insensitive). */
  query?: string
  /** Explicit pattern; `group 1` (or the whole match) is the code. Default {@link DEFAULT_CODE_PATTERN}. */
  pattern?: string
  /** Ignore messages older than this many seconds. */
  maxAgeSeconds?: number
  /** Folder to scan (backend specific name). */
  folder?: string
}

/** The extracted verification code plus the message it came from. */
export interface EmailCode {
  code: string
  subject: string
  from: string
  date: string
  messageId: string
}

/** A provider declaration: which plugin claims which provider id of which contract version. */
export interface EmailProviderDeclaration {
  /** Provider id claimed (e.g. `my-mailbox`). */
  provider: string
  /** Contract version claimed; must equal {@link EMAIL_VERSION}. */
  version: number
  /** Plugin that claims it (manifest name). */
  plugin: string
  /** Source id the plugin came from. */
  source: string
  /** True when the declaring plugin came from an external source. */
  external: boolean
}

/** Public view of a provider: who declared it, is it registered, is it enabled. */
export interface EmailProviderInfo {
  id: string
  contract: string
  plugin: string
  source: string
  external: boolean
  /** True when the provider is in the enabled (selection) list. */
  enabled: boolean
  /** True when a provider implementation registered for this declaration. */
  registered: boolean
  /** Provider backend description, when it offers one (never a secret). */
  describe?: string
}

/** The capability has no usable provider: nothing is enabled, or nothing registered. */
export class EmailNotConfiguredError extends Error {
  constructor(message: string) {
    super(`email: ${message}`)
    this.name = 'EmailNotConfiguredError'
  }
}

/** The referenced account label is not configured by the answering provider. */
export class EmailUnknownAccountError extends Error {
  readonly label: string

  constructor(label: string, known: string[]) {
    super(`email: unknown account '${label}' (configured: ${known.length ? known.join(', ') : 'none'})`)
    this.name = 'EmailUnknownAccountError'
    this.label = label
  }
}

/** No message matched (an id that does not exist, or no code found). */
export class EmailNotFoundError extends Error {
  constructor(message: string) {
    super(`email: ${message}`)
    this.name = 'EmailNotFoundError'
  }
}

/** Normalises a limit: positive integer, capped at {@link MAX_LIST_LIMIT}. */
export function normalizeLimit(limit: unknown, fallback: number = DEFAULT_LIST_LIMIT): number {
  if (limit === undefined || limit === null) return fallback
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    throw new Error(`email: 'limit' must be a number (got ${JSON.stringify(limit)})`)
  }
  const value = Math.floor(limit)
  if (value <= 0) throw new Error(`email: 'limit' must be a positive integer (got ${String(limit)})`)
  return Math.min(value, MAX_LIST_LIMIT)
}

/** Validates and normalises an account reference. Only the LABEL appears in errors. */
export function normalizeAccountRef(ref: AccountRef | undefined): AccountRef | undefined {
  if (ref === undefined || ref === null) return undefined
  const label = (ref as { label?: unknown }).label
  if (typeof label !== 'string' || label.trim().length === 0) {
    throw new Error('email: an account reference needs a non-empty label')
  }
  return { label: label.trim() }
}

/** The label of a reference, for messages (never a value). */
export function accountLabel(ref: AccountRef | undefined, fallback = '(default)'): string {
  return normalizeAccountRef(ref)?.label ?? fallback
}

/**
 * The code pattern of a call as a RegExp: the caller's `pattern` when given
 * (case-insensitive), the definition default otherwise. The code is `group 1`
 * when the pattern has one, the whole match otherwise.
 */
export function codePattern(pattern?: string): RegExp {
  if (pattern === undefined) return new RegExp(DEFAULT_CODE_PATTERN, 'i')
  if (typeof pattern !== 'string' || pattern.trim().length === 0) {
    throw new Error("email: 'pattern' must be a non-empty string")
  }
  try {
    return new RegExp(pattern, 'i')
  } catch (error) {
    throw new Error(`email: invalid 'pattern' (${error instanceof Error ? error.message : String(error)})`)
  }
}

/** Extracts the first code of `text` (or undefined). Never logs the text. */
export function extractCode(text: string | undefined, pattern?: string): string | undefined {
  if (typeof text !== 'string' || text.length === 0) return undefined
  const match = codePattern(pattern).exec(text)
  if (!match) return undefined
  const code = match[1] ?? match[0]
  return code === undefined || code.length === 0 ? undefined : code
}

/**
 * What a provider (implementation) must offer. Everything here is backend
 * agnostic: the definition does not know where a message comes from.
 * `accounts`, `list` and `get` are required; `code` and `search` are optional
 * because the definition implements both on top of the required three.
 */
export interface EmailProvider {
  /** Provider id, unique among providers (e.g. `my-mailbox`). */
  id: string
  /** Contract version implemented; must equal {@link EMAIL_VERSION}. */
  version: number
  /** Optional: human readable backend description (never contains a value). */
  describe?(): string
  /** The configured accounts, in configuration order (never a secret). */
  accounts(): Promise<EmailAccount[]> | EmailAccount[]
  /** The last messages of an account (default account when the ref is omitted). */
  list(ref?: AccountRef, options?: EmailListOptions): Promise<EmailSummary[]>
  /** One message: envelope fields plus the body in the asked format. */
  get(ref: AccountRef | undefined, id: string, options?: EmailGetOptions): Promise<EmailMessage>
  /** Optional: backend-native search (the definition falls back to `list`). */
  search?(ref: AccountRef | undefined, query: string, options?: EmailSearchOptions): Promise<EmailSummary[]>
  /** Optional: backend-native code extraction (the definition falls back to list+get). */
  code?(ref: AccountRef | undefined, options?: EmailCodeOptions): Promise<EmailCode>
}

interface ProviderEntry {
  descriptor: EmailProvider
  declaration: EmailProviderDeclaration
}

/**
 * The service of the capability. The abstract part is the CONSUMER contract
 * (`accounts`, `list`, `get`, `code`, `search`); the concrete part is the
 * PROVIDER contract (declarations, registration, selection) plus the two
 * backend-agnostic algorithms `code()` and `search()` that any provider can
 * override. It contains no backend logic.
 */
export abstract class EmailService extends Service {
  // Plain (runtime) properties, not `#private`: cordis wraps a service instance
  // in a Proxy for dependency tracking, and a Proxy breaks private-field access.
  protected declarations = new Map<string, EmailProviderDeclaration>()
  protected implementations = new Map<string, ProviderEntry>()
  protected enabledIds: string[] | undefined

  constructor(ctx: Context, name: string = EMAIL) {
    super(ctx, name)
  }

  /** The configured accounts (never a secret). */
  abstract accounts(): Promise<EmailAccount[]>
  /** The last messages of an account; `ref` omitted means the default account. */
  abstract list(ref?: AccountRef, options?: EmailListOptions): Promise<EmailSummary[]>
  /** One message by id, in the asked format. */
  abstract get(ref: AccountRef | undefined, id: string, options?: EmailGetOptions): Promise<EmailMessage>
  /** Extracts a verification code from a message (or from the newest matching one). */
  abstract code(ref: AccountRef | undefined, options?: EmailCodeOptions): Promise<EmailCode>
  /** Searches an account; the definition falls back to `list()` filtering. */
  abstract search(ref: AccountRef | undefined, query: string, options?: EmailSearchOptions): Promise<EmailSummary[]>

  /** Registers a provider declaration (from a manifest). */
  declare(declaration: EmailProviderDeclaration): void {
    if (!declaration.provider) throw new Error('email: a provider declaration needs a provider id')
    if (declaration.version !== EMAIL_VERSION) {
      throw new Error(
        `email: plugin '${declaration.plugin}' declares provider '${declaration.provider}' for contract version ` +
          `${declaration.version}, but this core speaks ${EMAIL_CONTRACT}`,
      )
    }
    const existing = this.declarations.get(declaration.provider)
    if (existing) {
      if (existing.plugin === declaration.plugin) return
      throw new Error(
        `email: provider id '${declaration.provider}' is declared twice (by '${existing.plugin}' and ` +
          `'${declaration.plugin}'); provider ids must be unique`,
      )
    }
    this.declarations.set(declaration.provider, declaration)
  }

  /**
   * Registers a provider implementation. Refuses providers whose id or contract
   * version was not declared by a manifest, so the MANIFEST is what makes a
   * provider resolvable. Returns the disposer.
   */
  register(descriptor: EmailProvider): () => void {
    if (!descriptor || typeof descriptor.id !== 'string' || descriptor.id.length === 0) {
      throw new Error('email: register() needs a provider id')
    }
    if (typeof descriptor.accounts !== 'function' || typeof descriptor.list !== 'function' || typeof descriptor.get !== 'function') {
      throw new Error(`email: provider '${descriptor.id}' must implement accounts(), list() and get()`)
    }
    const declaration = this.declarations.get(descriptor.id)
    if (!declaration) {
      throw new Error(
        `email: provider '${descriptor.id}' is not declared; declare it in the plugin manifest: ` +
          `"capabilities": [{ "id": "${EMAIL}", "version": ${EMAIL_VERSION}, "provider": "${descriptor.id}" }]`,
      )
    }
    if (descriptor.version !== EMAIL_VERSION) {
      throw new Error(
        `email: provider '${descriptor.id}' implements contract version ${descriptor.version}, ` +
          `but this core speaks ${EMAIL_CONTRACT}`,
      )
    }
    if (this.implementations.has(descriptor.id)) {
      throw new Error(`email: provider '${descriptor.id}' is already registered`)
    }
    const entry: ProviderEntry = { descriptor, declaration }
    this.implementations.set(descriptor.id, entry)
    return () => {
      if (this.implementations.get(descriptor.id) === entry) this.implementations.delete(descriptor.id)
    }
  }

  /**
   * Fixes the enabled providers and their precedence order. This is the ONLY
   * place provider selection happens, and it is fed by configuration
   * (`email.providers`).
   */
  setEnabled(ids?: readonly string[]): void {
    const requested = ids && ids.length > 0 ? [...ids] : [...this.declarations.keys()]
    const seen = new Set<string>()
    for (const id of requested) {
      if (seen.has(id)) throw new Error(`email: provider '${id}' is listed twice in the enabled providers`)
      seen.add(id)
      if (!this.declarations.has(id)) {
        const available = [...this.declarations.keys()]
        throw new Error(
          `email: provider '${id}' is not declared by any plugin (available: ` +
            `${available.length ? available.join(', ') : 'none'}); a provider must declare the capability in its ` +
            `manifest: "capabilities": [{ "id": "${EMAIL}", "version": ${EMAIL_VERSION}, "provider": "id" }]`,
        )
      }
    }
    // Declared but not selected providers stay registered; they never answer.
    // An empty selection means "every declared provider", so it stays DYNAMIC:
    // a provider declared after this call (a plugin loaded later) is enabled too.
    this.enabledIds = ids && ids.length > 0 ? requested : undefined
  }

  /** Enabled provider ids, in precedence order. */
  enabled(): string[] {
    return this.enabledIds ? [...this.enabledIds] : [...this.declarations.keys()]
  }

  /** Every known provider declaration, registered or not, enabled or not. */
  providers(): EmailProviderInfo[] {
    const enabled = new Set(this.enabled())
    return [...this.declarations.values()].map((declaration) => {
      const entry = this.implementations.get(declaration.provider)
      const describe = entry?.descriptor.describe?.()
      return {
        id: declaration.provider,
        contract: `${EMAIL}@${declaration.version}`,
        plugin: declaration.plugin,
        source: declaration.source,
        external: declaration.external,
        enabled: enabled.has(declaration.provider),
        registered: entry !== undefined,
        ...(describe === undefined ? {} : { describe }),
      }
    })
  }

  /** Registered provider lookup, for implementations of the abstract methods. */
  protected entry(id: string): EmailProvider | undefined {
    return this.implementations.get(id)?.descriptor
  }
}

/**
 * The default implementation of the definition: it walks the ENABLED providers
 * in order and answers through the first one that is registered. The walk is
 * the definition's own logic (no backend knowledge), so providers stay
 * replaceable: swapping the enabled provider swaps the whole backend, and the
 * consumers never notice.
 */
export class Email extends EmailService {
  /** The provider that answers: first enabled AND registered one. */
  protected answering(): EmailProvider {
    const enabled = this.enabled()
    for (const id of enabled) {
      const provider = this.entry(id)
      if (provider) return provider
    }
    const declared = enabled.length > 0 ? enabled.join(', ') : 'none'
    throw new EmailNotConfiguredError(
      `no email provider is available (enabled: ${declared}); enable a provider plugin and configure it, ` +
        `then select it with the 'email' section of the config (or leave that section out to use every declared provider)`,
    )
  }

  async accounts(): Promise<EmailAccount[]> {
    return await this.answering().accounts()
  }

  async list(ref?: AccountRef, options: EmailListOptions = {}): Promise<EmailSummary[]> {
    return await this.answering().list(normalizeAccountRef(ref), { ...options, limit: normalizeLimit(options.limit) })
  }

  async get(ref: AccountRef | undefined, id: string, options: EmailGetOptions = {}): Promise<EmailMessage> {
    if (typeof id !== 'string' || id.trim().length === 0) throw new Error("email: get() needs a non-empty message 'id'")
    return await this.answering().get(normalizeAccountRef(ref), id.trim(), { format: 'text', ...options })
  }

  async search(ref: AccountRef | undefined, query: string, options: EmailSearchOptions = {}): Promise<EmailSummary[]> {
    if (typeof query !== 'string' || query.trim().length === 0) throw new Error("email: search() needs a non-empty 'query'")
    const provider = this.answering()
    const account = normalizeAccountRef(ref)
    const limit = normalizeLimit(options.limit)
    if (provider.search) return await provider.search(account, query.trim(), { ...options, limit })
    // Backend-agnostic fallback: filter the newest messages on the fields the
    // envelope already carries. A provider with a native search answers better.
    const needle = query.trim().toLowerCase()
    const messages = await provider.list(account, { ...options, limit: MAX_LIST_LIMIT })
    return messages
      .filter((message) =>
        [message.subject, message.from, message.snippet ?? ''].some((field) => field.toLowerCase().includes(needle)),
      )
      .slice(0, limit)
  }

  /**
   * Verification code extraction. A provider that implements `code()` answers
   * natively; otherwise this backend-agnostic algorithm runs here:
   * read the newest messages (`id` short-circuits the search), skip those older
   * than `maxAgeSeconds`, keep those matching `query`, then read each body and
   * return the first code found, its message and its envelope. The returned
   * code is never logged by the definition.
   */
  async code(ref: AccountRef | undefined, options: EmailCodeOptions = {}): Promise<EmailCode> {
    const provider = this.answering()
    const account = normalizeAccountRef(ref)
    if (provider.code) return await provider.code(account, options)

    const folder = options.folder
    const pattern = options.pattern
    const since =
      typeof options.maxAgeSeconds === 'number' && Number.isFinite(options.maxAgeSeconds) && options.maxAgeSeconds > 0
        ? new Date(Date.now() - Math.floor(options.maxAgeSeconds) * 1000).toISOString()
        : undefined
    const listOptions: EmailListOptions = {
      limit: DEFAULT_CODE_SCAN_LIMIT,
      ...(folder === undefined ? {} : { folder }),
      ...(since === undefined ? {} : { since }),
    }

    let candidates: EmailSummary[]
    if (options.id !== undefined && options.id.trim().length > 0) {
      const id = options.id.trim()
      const message = await provider.get(account, id, { format: 'text' })
      candidates = [message]
    } else {
      candidates = await provider.list(account, listOptions)
      const needle = options.query?.trim().toLowerCase()
      if (needle !== undefined && needle.length > 0) {
        candidates = candidates.filter((message) =>
          [message.subject, message.from, message.snippet ?? ''].some((field) => field.toLowerCase().includes(needle)),
        )
      }
    }

    for (const candidate of candidates) {
      // The envelope carries no body: read the message itself through the
      // definition's own `get()` contract (format 'text').
      const message: EmailMessage = await provider.get(account, candidate.id, { format: 'text' })
      const code = extractCode(message.text, pattern) ?? extractCode(candidate.subject, pattern)
      if (code !== undefined) {
        return { code, subject: candidate.subject, from: candidate.from, date: candidate.date, messageId: candidate.id }
      }
    }
    throw new EmailNotFoundError(
      `no code found in ${candidates.length} message(s) of ${accountLabel(account)} ` +
        `(pattern ${pattern ?? DEFAULT_CODE_PATTERN}); pass an explicit 'pattern' or a wider 'maxAgeSeconds'`,
    )
  }
}

/**
 * Typed handle for every consumer/provider module: `ctx.email`. Consumers
 * import the DEFINITION (never a provider) and get full typing from this.
 */
declare module 'cordis' {
  interface Context {
    email: EmailService
  }
}

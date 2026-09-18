# Credentials: a three-role capability seam

Workbench serves credentials through a **capability seam with three roles**,
modelled on the DeepSeek-Harness practice
(<https://deepseek-harness.github.io/deepseek-harness/en/develop/practice/>):

```
   Provider   ->   Definition   <-   Consumer
 (impl.)          (contract)        (usage)
```

| Role | What it is | Where it lives | Who may import whom |
| --- | --- | --- | --- |
| **Service Definition** | the contract: types, the service, the registration/lookup rules. Names no provider, no backend, no env/file/vault vocabulary. | core: `src/credentials/definition.ts` (exported from `src/index.ts`) | imports nothing from this package (`Provider -> Definition <- Consumer`) |
| **Service Provider** | one implementation of the contract (`env`, `file`, `project-env`, `user-env` are core; anything else is a plugin) | core: `src/credentials/providers/<name>.ts`; external: any plugin that declares the capability | may import the Definition, never a Consumer |
| **Consumer** | uses the capability and does not know which provider answers | `src/config.ts` (config reference expansion), `src/cli.ts` (the `credentials` commands), plugins via `ctx.credentials` | may import the Definition, never a Provider |

The seam is the **whole capability**, not one role: a provider can be added,
removed or replaced by config, and a consumer keeps working unchanged.

The rule is enforced by `npm run check:seam` (`scripts/check-seam.ts`, pinned by
`test/seam.test.ts`). It fails on a Consumer -> Provider import and on a
Provider -> Consumer import, so the arrows can only point at the Definition.

## 1. The contract (`credentials@1`)

The capability id is `credentials`; the contract version a provider implements
is `1` (`CREDENTIALS_VERSION`), rendered as `credentials@1`
(`CREDENTIALS_CONTRACT`). A reference is a **name plus an optional scope** -
never a value:

```ts
interface CredentialRef {
  name: string      // e.g. 'deploy-token'
  scope?: string    // e.g. 'team' (namespaces the name)
}
```

A reference may be written `NAME` or `SCOPE/NAME`; the service normalises the
qualified form before any provider sees it.

The service a consumer talks to (`ctx.credentials`, typed by the
`declare module 'cordis'` augmentation in the Definition):

| Member | Meaning |
| --- | --- |
| `resolve(ref)` | the value plus the answering provider (`{ ref, value, provider, contract }`), or `undefined` when no enabled provider has it. Provider failures are reported as an error that names the reference and the failing providers, never a value. |
| `explain(ref)` | a `ResolutionTrace`: one `{ provider, status, error? }` attempt per enabled provider (`answered` / `missing` / `error` / `not-registered`). Names and statuses only, no values. |
| `list()` | credential NAMES the enabled providers can answer (sorted, never values). |
| `providers()` | every known provider: id, contract, declaring plugin, source, `external`, `enabled`, `registered`, `describe?`. |
| `enabled()` | the enabled provider ids in precedence order. |

The provider-side members (`declare`, `register`, `setEnabled`) are what the
composition root and provider plugins use; they are described in section 3.

A provider is a plain object - the whole provider contract:

```ts
interface CredentialProvider {
  id: string                                  // must match the manifest declaration
  version: number                             // must equal 1 (credentials@1)
  resolve(ref: CredentialRef): string | undefined | Promise<string | undefined>
  list?(): string[] | Promise<string[]>       // names, never values
  describe?(): string                         // backend description, never a value
}
```

`resolve` returns `undefined` for "not found" and THROWS for a real failure
(unreadable file, HTTP 500, ...). The service skips a throwing provider, records
it in the trace, and keeps walking; if nothing answered and a provider failed,
`resolve` raises an error naming the reference and the failing providers - a
failure is never silently reported as "missing".

Empty strings are treated as "not found" everywhere.

## 2. The four core providers

All four live in `src/credentials/providers/` and are **core** implementations
(an explicit operator decision for this capability). Each is a separate module;
none of them is referenced by a consumer.

Every provider accepts a credential name in any of its candidate forms: the name
as written, its ENV form (`deploy-token` -> `DEPLOY_TOKEN`) and its kebab form
(`DEPLOY_TOKEN` -> `deploy-token`). The first matching form wins.

| Provider id | Plugin name | Backend | Config (under `plugins:<plugin name>`) |
| --- | --- | --- | --- |
| `env` | `credentials-env` | the direct process environment (`process.env`) | none (unknown keys are an error) |
| `file` | `credentials-file` | one credentials file: a JSON or YAML mapping of names to values; a nested mapping is a SCOPE namespace | `path` (default `credentials.json` next to the config file), `format` (`json` \| `yaml`, default by extension) |
| `project-env` | `credentials-project-env` | the PROJECT level env file (dotenv syntax) | `dir` (default: the config file directory), `file` (default `<dir>/.env`; wins over `dir`) |
| `user-env` | `credentials-user-env` | the USER level env file (dotenv syntax) | `dir` (default: `$HOME`, then the OS home), `file` (default `<dir>/.env`; wins over `dir`) |

Semantics that are easy to get wrong, pinned by tests:

- `env` ignores `ref.scope` (the process environment is flat).
- `file` resolves `SCOPE/NAME` in `document[SCOPE][NAME]`, and a plain `NAME` in
  `document[NAME]`. A file key holding a non-string is a config error naming the
  key and the file, never a value. A missing file means "not found", not an
  error.
- `project-env` / `user-env` parse dotenv text: `KEY=VALUE` per line, blank lines
  and `#` comments skipped, an optional leading `export ` ignored, one layer of
  matching quotes stripped, and the FIRST occurrence of a key wins. A missing
  file means "not found".
- The env-shaped providers look a name up exactly, then in its ENV form; the file
  provider in all three candidate forms.

### Uncertainty about DSH's exact semantics

DSH documents the three roles and the four provider names but not (in the pages
reachable from the practice URL above) the concrete lookup rules or a precedence
order. The rules above are therefore workbench's own documented choices; where a
DSH page states a rule explicitly, this document should be corrected to match it.

## 3. Selection and precedence are configuration

`credentials` is a top-level config section:

```yaml
credentials:
  # Enabled providers, IN PRECEDENCE ORDER (first answering wins).
  # Omitted/empty = every declared provider, in declaration order
  # (core first: env, file, project-env, user-env; then externals).
  providers: [env, file]
  # Default scope for unscoped references (a FALLBACK, see section 4).
  scope: team
```

- Swapping a provider is a **config edit only** - never a code change, and never
  a core change for an external provider.
- An unknown id is an error that names the available providers.
- A declared, registered provider that is not enabled never answers (it still
  appears in `providers()` with `enabled: false`).
- Each provider works with the other three disabled.

The provider declarations themselves come from two places (the composition root
is the only place that knows both sides):

1. the **core provider modules** (registered with their declaration), and
2. the **manifests** of the loaded plugins: a plugin that provides the
   capability writes
   `"capabilities": [{ "id": "credentials", "version": 1, "provider": "stub-vault" }]`.

`ctx.credentials.register(provider)` refuses a provider whose id was not declared
by a manifest: **the manifest declaration is what makes a provider resolvable**.
This is additive - a manifest that uses the short string form
(`"capabilities": ["command:hello world"]`) keeps loading exactly as before.

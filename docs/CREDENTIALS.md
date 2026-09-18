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

## 4. Referencing a credential from config (`${cred:NAME}`)

The config loader is a CONSUMER: it resolves through the credentials service and
never imports a provider. Anywhere a STRING config value is accepted, the
following references are expanded:

```
${cred:NAME}          ${secret:NAME}          ${cred:SCOPE/NAME}
```

`cred` and `secret` are aliases with byte-identical behaviour.

Rules:

- The reference body is trimmed; `SCOPE/NAME` is split at the FIRST `/`, so
  `team/deploy-token` resolves with scope `team` and name `deploy-token`
  (a provider that ignores scopes still answers for the name - see section 2).
- An EMPTY reference (`${cred:}` / `${secret:  }`) is a config error.
- An unresolvable reference is a HARD error naming the reference and the enabled
  providers tried, never a value:

  ```
  config: credential 'deploy-token' could not be resolved by the enabled provider(s) env, file; check the credential name and the 'credentials' section of the config
  ```

- `credentials.scope` (section 3) is a FALLBACK, not an override: an unscoped
  reference is looked up UNSCOPED first (a flat `env` value, `document[NAME]` in
  the file provider) and only when that misses is it looked up again as
  `SCOPE/NAME`. `${cred:NAME}` therefore keeps working for a top-level
  credential, while unscoped references can still reach a scoped one. When the
  fallback was tried, the error message says so
  (`(the default scope 'team' was tried as well)`).
- `${env:VAR}` is expanded earlier, with its own pattern, and behaves exactly as
  before - the two kinds of reference may appear in the same file and in the
  same value.
- A resolved value is inserted into the config in memory only. It is never
  written back to disk, never logged and never named in an error: the CLI masks
  it (`****`) and messages carry the reference, not the value.

```yaml
credentials:
  providers: [env, file]
  scope: team            # fallback for unscoped references

plugins:
  hello-world:
    # resolved through the credentials service, provider agnostic
    message: "token is ${cred:DEPLOY_TOKEN}"   # or ${secret:DEPLOY_TOKEN}
    scoped: "team is ${cred:team/deploy-token}"
```

`${env:VAR}` remains the way to inject NON-secret environment values; use
`${cred:NAME}` for anything that is a credential, so a provider can be swapped
without touching the consumer.

## 5. Adding an external provider (Vault-style example, step by step)

A provider from ANOTHER repository is added without a single core change. The
working example is `nexuslbs/workbench-plugins`, plugin
`plugins/credentials-stub` (a Vault-KV-v2-style HTTP backend); the steps below
are exactly what that plugin does.

**1. Author the plugin in the external repo** (never in the core): a plugin
directory with a `workbench.plugin.json` manifest, an entry file exporting the
cordis plugin (`apply(ctx, config)`), a README and a test. Import the contract
types from the core's public API (`src/index.ts` re-exports the Definition) so
the provider implements the documented interface.

**2. Declare the capability in the manifest.** This declaration is what makes
the provider resolvable - `ctx.credentials.register()` refuses a provider whose
id was not declared by a manifest:

```json
{
  "name": "credentials-stub",
  "version": "0.1.0",
  "entry": "index.ts",
  "capabilities": [{ "id": "credentials", "version": 1, "provider": "stub-vault" }]
}
```

The `capabilities` field is ADDITIVE: a manifest using the short string form
(`"capabilities": ["command:hello world"]`) keeps loading unchanged.

**3. Implement the contract** (section 1) in the plugin: a provider object with
`id` (must match the manifest `provider`), `version` (must equal `1`), and
`resolve(ref)`; `list()` / `describe()` are optional. `resolve` returns
`undefined` for "not found" and THROWS for a real failure.

**4. Register it when the plugin is applied**, e.g. in `apply(ctx, config)`:
`ctx.credentials.register(provider)` (`ctx.credentials` is typed by the
Definition's `declare module 'cordis'` augmentation).

**5. Wire the external source into the workbench config** (the source is an
ordinary external source, exactly like any other plugin):

```yaml
sources:
  - kind: path            # or kind: git in production
    id: workbench-plugins
    path: ../workbench-plugins/plugins
    external: true
```

**6. Select it - one config row, no code change:**

```yaml
credentials:
  providers: [stub-vault]   # selection is configuration only
```

A declared, registered provider that is not enabled never answers; it still
appears in `workbench credentials providers` with `enabled: false`.

**7. Give it its own configuration** under `plugins:<plugin name>` (here: the
endpoint, the mount and an optional token - never a credential VALUE):

```yaml
plugins:
  credentials-stub:
    url: http://127.0.0.1:8200
```

**8. Use it from the SAME consumer, unchanged.** Any config value with
`${cred:NAME}` (section 4) or any plugin calling
`ctx.credentials.resolve({ name })` is served by the external provider. A
consumer never imports a provider, so swapping `credentials.providers` between a
core provider and `stub-vault` changes the answer and nothing else.

**9. Verify** with the CLI rather than by reading code:

```sh
workbench credentials providers            # lists providers, their contract, source, enabled
workbench credentials resolve deploy-token  # prints the value masked and the provider that answered
workbench credentials explain deploy-token  # per-provider trace: answered / missing / error
```

**10. Hygiene:** the provider must not log, echo or persist values and its errors
must name the endpoint and the reference, never the value (section 4). Keep real
tokens in the provider's own configuration as `${env:VAR}` / `${secret:NAME}`
references; never commit them.

## Private plugin sources: source auth + the BOOTSTRAP credential set

`kind: git` sources may declare `auth`: a credential REFERENCE (a name), never a
value. The value is resolved by the **bootstrap credential set** and is used
TRANSIENTLY for that one fetch.

### Why a bootstrap set (source fetch happens BEFORE plugin discovery)

`createKernel` resolves sources (and their auth) BEFORE it discovers any plugin
(`src/kernel.ts`: the source walk runs first, and the credentials-provider plugins
are only found in that same walk). A credential needed to FETCH a source therefore
cannot come from a plugin-provided provider: that provider is itself discovered in
a source. `src/credentials/providers/bootstrap.ts` closes the gap by instantiating the CORE
provider modules (`env`, `file`, `project-env`, `user-env`) DIRECTLY, with no
cordis context and no plugin, from the same `plugins.<provider>` config sections.
It speaks the very same `CredentialConsumer` contract (`resolve`/`explain`/`list`)
that `ctx.credentials` implements, so a consumer never knows which of the two it
talks to.

Layering (both halves are the same Definition; only availability differs):

| Layer | Made of | Available | Used by |
| --- | --- | --- | --- |
| bootstrap set | CORE providers only, no plugins, no cordis | before any plugin is loaded | `git` source auth (fetch), the loader/host |
| `ctx.credentials` | core + plugin-provided providers, selected by `credentials.providers` | after plugins load | config `${cred:NAME}` / `${secret:NAME}` expansion, plugins |

Selection is configuration: `credentials.bootstrap` lists the core provider ids in
precedence order (default: all four, in declaration order). Only CORE ids are
accepted - an unknown id (including a plugin provider id, which cannot exist yet)
is a loud config error, never a silent fallback. When the bootstrap set yields
nothing, the source is reported as a per-source error and the loader SKIPS it: the
other sources still load, and no anonymous fetch is attempted.

### git source auth

```yml
sources:
  - kind: git
    id: workbench-plugins-private
    url: https://github.com/nexuslbs/workbench-plugins-private
    ref: main                      # branch, tag or sha (unchanged semantics)
    subdir: plugins                # optional, unchanged
    auth:
      type: github-app             # or `token` (default)
      credential: GITHUB_APP_KEY   # a NAME, resolved by the bootstrap set
      appId: 3967918               # github-app: the App id (not a secret)
      installationId: 138119822    # github-app: the installation (not a secret)
      # apiBase: https://api.github.com   # GitHub Enterprise
      # username: x-access-token         # token: basic-auth user
```

- `type: token` (default): the credential VALUE is the token; it is sent as
  `-c http.extraheader=Authorization: Basic base64(username:token)`.
- `type: github-app`: the value is a GitHub App PRIVATE KEY (PEM). A short-lived
  installation access token is minted through the documented REST flow: an RS256
  JWT (`iat` = now-60s, `exp` = now+9min, `iss` = app id) is sent as
  `Authorization: Bearer <jwt>` to `POST {apiBase}/app/installations/{installationId}/access_token`
  (`Accept: application/vnd.github+json`, `X-GitHub-Api-Version: 2022-11-28`),
  which answers `{ "token": "ghs_...", "expires_at": "<ISO>" }`. Installation
  tokens expire after ~1h; the minted token is cached IN MEMORY with a 5 minute
  safety skew, so a long-running `serve` re-mints on its next source resolution
  instead of failing on an expired token. The JWT is never stored.
- Secret hygiene: the credential is never written into the checkout. git gets
  `-c credential.helper=` (so no configured helper can persist or replay
  anything) plus the transient `http.extraheader`; `origin` keeps the plain
  configured url, no credential file is created, and every error/log path passes
  the git arguments through `redactArgs` (the header value becomes `<redacted>`).
- Failure: a missing/wrong credential produces
  `source '<id>' (git <url> @ <ref>): authentication failed: ...` and that source
  is skipped; a source that declares `auth` is NEVER fetched anonymously, and a
  stale checkout is never served in its place.

NEVER version a key. The key material is operator-provided at runtime: an exported
env var (`export GITHUB_APP_KEY=...`, resolved by the `env` provider), a
`credentials.json` next to the config file (the `file` provider), or a mounted
secret file - and the config references it BY NAME only.

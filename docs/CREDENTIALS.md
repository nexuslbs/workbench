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

## 2. The four basic providers (plugin `credentials-basic`)

The core ships **NO** credential provider: every provider is a PLUGIN (operator
rule 2026-09-19, "the core must be minimal"). The four BASIC backends live in the
plugin `credentials-basic` of the PUBLIC plugins repository
(`nexuslbs/workbench-plugins`, `plugins/credentials-basic/`), each a separate
module. The plugin holds NO secret value: it resolves a credential NAME against
the environment / files at RUNTIME, which is why publishing it is safe - and why
it can be fetched from a source that needs no credential at all (section 6).

Because the provider is an external plugin, its four backends are configured in
ONE config row, one optional sub-object per backend; an absent sub-object
registers that backend with its DEFAULTS:

```yaml
plugins:
  credentials-basic:
    env: {}                              # the process environment
    file: { path: ./credentials.json }   # one JSON credentials file
    projectEnv: { dir: . }               # <dir>/.env
    userEnv: { dir: /home/ci }           # the per-user scope
```

Every provider accepts a credential name in any of its candidate forms: the name
as written, its ENV form (`deploy-token` -> `DEPLOY_TOKEN`) and its kebab form
(`DEPLOY_TOKEN` -> `deploy-token`). The first matching form wins.

| Provider id | Backend | Config (under `plugins.credentials-basic`) |
| --- | --- | --- |
| `env` | the direct process environment (`process.env`) | none (unknown keys are an error) |
| `file` | one credentials file: a JSON mapping of names to values; a nested mapping is a SCOPE namespace | `path` (default `credentials.json` next to the config file) |
| `project-env` | the PROJECT level env file (dotenv syntax) | `dir` (default: the config file directory), `file` (default `<dir>/.env`; wins over `dir`) |
| `user-env` | the USER level env file (dotenv syntax) | `dir` (default: `$HOME`, then the OS home), `file` (default `<dir>/.env`; wins over `dir`) |

Each backend declares its provider id in the plugin manifest
(`{"id": "credentials", "version": 1, "provider": "env"}`, ...), which is what
lets the core accept the registration.

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
  # (credentials-basic declares env, file, project-env, user-env; then others).
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
${cred:NAME}          ${cred:SCOPE/NAME}
```

**Reference syntax: intentional breaking change.** `${cred:NAME}` (scoped:
`${cred:SCOPE/NAME}`) is the ONE credential reference form. A config value that
still carries the legacy alias - the very same reference body written with the
kind token `secret` instead of `cred` - is NOT resolved any more: the loader
fails fast with a config error that names the offending reference and the
supported form, for example

```
config: '<the offending reference>' is not a credential reference: the legacy 'secret' alias was removed; write '${cred:NAME}' (or '${cred:SCOPE/NAME}') instead - see docs/CREDENTIALS.md
```

so a stale config is caught at boot instead of silently keeping a reference that
would never resolve.

Rules:

- The reference body is trimmed; `SCOPE/NAME` is split at the FIRST `/`, so
  `team/deploy-token` resolves with scope `team` and name `deploy-token`
  (a provider that ignores scopes still answers for the name - see section 2).
- An EMPTY reference (`${cred:}`) is a config error.
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
    message: "token is ${cred:DEPLOY_TOKEN}"
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
tokens in the provider's own configuration as `${env:VAR}` / `${cred:NAME}`
references; never commit them.

## 6. Private plugin sources: source auth and the credentials-provider GATE

`kind: git` sources may declare `auth`: a credential REFERENCE (a name), never a
value. The value is resolved through the credentials service and is used
TRANSIENTLY for that one fetch.

### The GATE: a credential-dependent entry loads only after a provider is loaded

An entry - a SOURCE or a PLUGIN roster row - whose config uses `${cred:...}` (or a
source `auth:`) implicitly DEPENDS on the credentials service provider: a plugin
that implements the `credentials@1` service definition and registers a provider
The core ships NO provider, so such an entry is **DEFERRED**:

1. The loader walks the sources and loads every source that needs NO credential -
   that is where a credentials provider plugin comes from.
2. A source or plugin row that needs a credential is DEFERRED: it is reported
   (`... is DEFERRED: its config needs a credential ... but no plugin implementing
   credentials@1 is loaded yet`) and the boot COMPLETES with zero plugins loaded.
   No crash, no silent skip, no anonymous fetch.
3. As soon as a plugin has registered a provider (`ctx.credentials.register`), the
   deferred entries become ELIGIBLE and are resolved in the SAME boot through the
   live credentials service.

That is what breaks the bootstrap chicken-and-egg: the provider implementation
lives in the PUBLIC plugins repository, is fetchable from a remote source that
needs no credential, and only after it is loaded do the `${cred:...}` sources and
plugin rows become loadable.

PRECEDENCE RULE (binding): credential-free sources and plugin rows resolve first;
credential-dependent entries resolve as soon as a provider is registered in the
same boot. A provider plugin MUST therefore be reachable from a source that needs
no credential (a `path` source, the PUBLIC `git` source, or a private source whose
OWN credential is already resolvable). `credentials.bootstrap` no longer exists:
selection is `credentials.providers` alone (section 3).
The CREDENTIALS PHASE loads every plugin that declares the `credentials`
capability, whether it is a PROVIDER (the declaration carries a
`provider` id) or a GIT AUTH STRATEGY (no id, e.g. the
`credentials-github-app` plugin). Both must be reachable from a
credential-free source: a strategy plugin that arrived AFTER the gated
resolution could not serve the `git` source it exists for.

| Phase | Made of | Available | Used by |
| --- | --- | --- | --- |
| 1 - credential-free sources | `path`/`git` sources with no `auth` | at boot, before any plugin | fetching the credentials provider plugin |
| 2 - gated entries | provider plugins registered on `ctx.credentials`, selected by `credentials.providers` | once a provider is registered | `git` source auth (fetch), config `${cred:NAME}` expansion, plugins |

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
      credential: GITHUB_APP_KEY   # a NAME; the credentials provider plugin resolves it
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
  `Authorization: Bearer <jwt>` to `POST {apiBase}/app/installations/{installationId}/access_tokens`
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

NOTE (verified 2026-09-19): a PEM credential must reach the provider with REAL
newlines. The `file` provider (a JSON document) carries them naturally; a dotenv
file cannot carry an escaped `\n` (the basic dotenv parser is single-line), so for
a private key prefer the `file` provider or a real multi-line env var. An INDENTED
PEM block is also rejected by the DER decoder: the base64 lines must not be padded
with spaces.

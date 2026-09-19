# workbench plugin contract

This is the contract every workbench plugin follows. The core repository ships
NO plugin: every plugin is EXTERNAL and the core loads them all through the
same mechanism (a plugin source). It is
intentionally small: the core hosts plugins, it does not know anything about
what they do.

## 1. Layout

One plugin = one directory containing a manifest and an entry module:

```
<source-dir>/
  my-plugin/
    workbench.plugin.json     # manifest (required)
    index.ts                  # entry module (the manifest's `entry`)
    ...                       # anything else the plugin needs
```

A plugin **source** is a directory of such plugin directories. The core scans
the immediate subdirectories of every configured source and DISCOVERS each one
that contains a `workbench.plugin.json`; the plugin is LOADED only when the
config names it under `plugins:` (see "Sources, the ROSTER and the `disabled`
park" below).

## 2. Manifest (`workbench.plugin.json`)

```json
{
  "name": "hello-otherworld",
  "version": "0.1.0",
  "description": "External test plugin: registers the 'hello otherworld' command",
  "entry": "index.ts",
  "capabilities": ["command:hello otherworld"],
  "config": {
    "type": "object",
    "properties": { "message": { "type": "string", "default": "Hello Otherworld" } }
  }
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique plugin name. It is authoritative: the core overrides the entry export's `name` with it and uses it to look up the plugin config. |
| `version` | yes | Plugin version. |
| `entry` | yes | Entry module, relative to the plugin directory. ESM (`.ts` under Node >= 22.18, or `.js`). |
| `description` | no | Human readable summary. |
| `capabilities` | no | What the plugin provides, e.g. `command:hello world`; shown by `workbench plugins`. |
| `config` | no | JSON-schema-ish description of the plugin config; documentation for the operator. |

Manifest problems (missing manifest/fields, unknown entry) are reported as load
failures; they never crash the core.

## 3. Entry module

The entry module exports the plugin as a **cordis plugin** (default export), and
declares which core services it uses:

```ts
export const name = 'hello-otherworld'

export function apply(ctx, config = {}) {
  const message = config.message ?? 'Hello Otherworld'
  // register the capability, and let cordis tear it down on unload
  ctx.effect(() => ctx.workbench.registerCommand({
    name: 'hello otherworld',
    description: 'prints the external greeting',
    run: () => message,
  }))
}

export default { name, inject: ['workbench'], apply }
```

Rules:

1. `inject: ['workbench']` is **required** for every plugin that touches the core
   service; cordis refuses `ctx.workbench` access without it ("cannot get property
   workbench without inject").
2. `apply(ctx, config)` receives the plugin's config object (from the core
   config `plugins.<name>`, `{}` when absent). No other core internals are
   reachable.
3. The plugin may `export default` either the plugin object above or a bare
   `apply` function (then `name` comes from the manifest and `inject` cannot be
   declared that way).
4. Everything the plugin creates must be registered as a cordis effect
   (`ctx.effect(...)`), so unload/restart tears it down cleanly. `registerCommand`
   returns the matching disposer.
5. The plugin directory is the plugin's own; it must not read or write the core
   tree. Plugins are self-contained and must not depend on another repository's
   runtime (an external plugin must not import the core package - the context
   service is the whole interface).
6. **`apply()` must not require optional config.** Only a plugin the config
   NAMES under `plugins:` is applied (see "Sources, the ROSTER and the
   `disabled` park" below); its row is its config and is `{}` when the row has no
   fields. A plugin whose capability needs configuration must therefore stay
   LOADABLE with an empty row: report a "not configured" state gracefully and
   fail only when the capability is actually used. An `apply()` that THROWS is a load failure (it is
   listed under `failures`); "not configured" is not an error and must never be
   reported as one.
7. **A manifest capability is DECLARED before the plugin is applied.** When a
   manifest declares a structured capability (`capabilities: [{ "id":
   "credentials", "version": 1, "provider": "stub-vault" }]`), the core declares
   it to that capability's service right before `apply()` runs - on the boot
   path and on every host-driven load (`load` / `reload` / `retry` / `enable`) -
   so `apply()` can register what its manifest announced and `register()` never
   answers "not declared". The manifest stays what makes a provider resolvable:
   registering an id no manifest declared is still an error.

### Sources, the ROSTER and the `disabled` park

`sources:` says where plugins are **DISCOVERED**; `plugins:` is the **ROSTER**, the
list of plugins that are **LOADED**. A plugin DIRECTORY inside a scanned source is
DISCOVERED - it is part of the "available plugins" inventory - and it is LOADED
only when the config names it under `plugins:`.

- a discovered plugin WITH a `plugins.<name>` row is imported, and the row is
  passed to `apply(ctx, config)` (a row with no fields is `{}`);
- a discovered plugin WITHOUT a row is **`available`**: the inventory
  (`workbench plugins`, the Plugin Inventory page) reports its name, version,
  source, directory and capabilities, but the loader NEVER imports it. That is
  the answer to "which plugins can I load?", and `enable` turns one into a
  loaded plugin by persisting its row;
- `plugins.<name>.disabled: true` is the **park**: the row stays (the plugin is
  configured, deliberately off), the plugin is NOT imported and it is reported
  under `disabled`, never under `failures`. It is a config edit, so it survives a
  restart, and the plugin manager UI persists exactly this key (enable creates
  or clears it, disable sets it);
- plugin NAMES are unique across sources: when two sources expose the same name,
  resolution is deterministic - the FIRST source in `sources:` order wins - and
  the later discovery is reported under `failures` and is never loaded.

The row is the plugin's config AND its selection, so `apply()` is only ever
called for a plugin the operator asked for - which is why a named plugin can
still receive `{}` (write `settings: {}`, or an empty `settings:`) and `apply()`
must not require optional config (rule 6).

```yaml
sources:
  # every plugin DIRECTORY here is DISCOVERED (available)
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins

plugins:
  # ROSTER: loaded here, with this config
  hello-otherworld:
    message: Hello Otherworld
  # PARKS a discovered plugin: configured, deliberately not loaded
  credentials-stub:
    disabled: true
  # every OTHER discovered plugin has no row -> `available`:
  # reported by the inventory, never imported, one `enable` persists its row
```

The manifest `config` block is **documentation for the operator** (JSON-schema
ish, shown by the UI): the core never validates it, so it can never produce a
load error by itself. What the core does with a `plugins.<name>` value is pass
it to `apply()` and read `disabled` out of it.

A plugin that reports a not-configured state must stay OUT of the failures list:
only a real load error (an import or `apply()` throw, a missing manifest field or
entry module) is a failure. A credentials provider that is not configured is the
reference example: it is still DECLARED by its manifest (so
`ctx.credentials.providers()` lists it) but it registers NO provider
(`registered: false`) and announces the missing config through its plugin log;
`stub-vault` in `nexuslbs/workbench-plugins` `plugins/credentials-stub` works
exactly like that.

## 4. Core service (`ctx.workbench`)

| Member | Meaning |
| --- | --- |
| `registerCommand({ name, description?, run })` | Registers a command; `name` is a space separated command path (`hello world`). Returns the disposer that unregisters it. Throws on empty name, missing `run`, or a name collision. |
| `commands()` | The commands registered so far. |
| `resolve(argv)` | Longest-match resolution of argv to a command plus the remaining args. |
| `plugins()` | The plugins the core loaded (name, version, source, capabilities). |
| `log(message)` | Log through the core (stderr in the CLI). |

The CLI runs a command as `workbench <name words...> [args...]`, prints the
returned string on stdout and exits non-zero for an unknown command.

## 4b. Credentials capability (`ctx.credentials`)

Credentials are a **capability seam with three roles** (definition, provider,
consumer) - see [CREDENTIALS.md](CREDENTIALS.md) for the full contract. The core
ships the DEFINITION ONLY: the four basic providers (`env`, `file`,
`project-env`, `user-env`) live in the PLUGIN `credentials-basic` of the public
plugins repository:

- **Definition** (core, `src/credentials/definition.ts`, exported from
  `src/index.ts`): the typed contract, the `credentials@1` version, and the
  `ctx.credentials` handle. It names no provider and no backend.
- **Provider**: an implementation of the contract. A plugin that provides one
  declares it in its manifest - the declaration is what makes the provider
  resolvable:

  ```json
  {
    "name": "credentials-vault",
    "entry": "index.ts",
    "capabilities": [{ "id": "credentials", "version": 1, "provider": "vault" }]
  }
  ```

  The string form (`"capabilities": ["command:hello world"]`) keeps working:
  the capability field is additive. An external provider is then wired as an
  ordinary external source and selected by configuration only (step-by-step
  recipe in [CREDENTIALS.md](CREDENTIALS.md) section 5; working example:
  `nexuslbs/workbench-plugins` `plugins/credentials-stub`, a Vault-style HTTP
  backend):

  ```yaml
  sources:
    - kind: path            # or kind: git in production
      id: workbench-plugins
      path: ../workbench-plugins/plugins
      external: true

  credentials:
    providers: [vault]      # selection is configuration only
  ```

  No core change is involved: the manifest declaration above plus these two
  config rows are the whole wiring.
- **Consumer**: uses the capability through `ctx.credentials` (or the config
  `${cred:NAME}` references). A consumer never imports a
  provider, and a provider never imports a consumer.

Dependency direction is `Provider -> Definition <- Consumer`, enforced by
`npm run check:seam` (see `scripts/check-seam.ts`, pinned by `test/seam.test.ts`).

Secrets are referenced by name only. A plugin never receives secret values
inline: it asks the credentials service for a reference, and the value it gets
back is never logged, echoed or persisted. Error messages name the reference and
the providers tried, never a value. The operator config references them
(`${env:VAR}` and `${cred:NAME}` expansion are both available in config values)
and the core decides how to hand them over.

## 4c. Web capability (`ctx.web`)

The Web UI is composed ONLY of plugins - the CORE INCLUDED: since v0.0.3 the
core ships no server, no router, no page and not even the capability
Definition. The whole web module lives in the PUBLIC
`nexuslbs/workbench-plugins` repository. It is the same three-role seam as
credentials (`Provider -> Definition <- Consumer`, `web@1`):

- **Definition**: `definitions/web.ts` of `nexuslbs/workbench-plugins` (the
  typed contract, the `Web` service handle, `WEB_CONTRACT = 'web@1'` and the
  defaults). It touches no socket, no file, no cordis module and no core module:
  being external, it may depend on nothing but itself. The core does NOT export
  it any more - importing the core no longer hands you the web seam.
- **Provider**: the plugin `web-impl` of the same repository, declaring
  `{ "id": "web", "version": 1, "provider": "http" }` in its manifest. It
  provides the seam as the `web` SERVICE (so a consumer from ANY source
  registers through `ctx.web`), owns the `node:http` listener and serves, in
  order: the minimal shell (`/`, any registered page path, `/shell.css`,
  `/shell.js`), the static assets plugins registered (read from the plugin
  directory on every request), the routes plugins registered, its own `/health`,
  then a JSON 404. Everything it registers is disposed on unload: no global
  state, no socket left behind.
- **Consumer**: a UI plugin. It registers routes/assets/pages through `ctx.web`
  and never imports a provider. A consumer from another repository declares the
  seam STRUCTURALLY (its own request/response/route types), exactly like the
  other service seams, because the Definition is not a core module.

`inject: ['web']` is required to touch the seam. Every registration returns its
disposer, so wrap it in `ctx.effect(...)` and unloading the plugin removes its
routes, assets and pages cleanly.

### The `web@1` deferral gate (v0.0.3)

The core still READS the `web:` config section, but it implements nothing: an
enabled section is a REQUEST that only a plugin providing `web@1` can serve. The
gate has the same shape as the `${cred:}` one:

- `served`: a loaded plugin declares the capability
  `{ "id": "web", "version": 1, "provider": "..." }`. The core reports it (the
  plugin name, its provider id, its source), registers its OWN routes
  (`/health`) on the seam and then STEPS BACK: the plugin owns the port, and the
  core must not bind it (a second listener would crash with `EADDRINUSE`).
- `deferred`: `web.enabled: true` and NO provider plugin loaded. Structured
  output (`GET /health` reports `web.state: "deferred"` plus the reason), one
  loud log line, no crash and no silent skip; the process keeps serving. The
  section becomes eligible the moment such a plugin is loaded.
- `off`: nothing was asked for.

| Member | Meaning |
| --- | --- |
| `ctx.web.route({ method, path, handler, description? })` | Registers one route (one method + one exact path). `handler(request)` returns `{ status?, contentType?, headers?, body? }`, or nothing to fall through to the 404. Registers `GET /api/...` JSON endpoints and anything else the plugin needs. |
| `ctx.web.asset({ path, file, contentType? })` | Serves one file verbatim at one URL path (`file` is absolute, typically inside the plugin directory: no build step, the browser gets the source). The MIME type defaults from the file extension. |
| `ctx.web.page({ id, title, path, module, description? })` | Adds one nav entry + one page to the shell. `path` is the URL the shell answers with itself, `module` the browser module URL the shell imports to mount the page. Page ids and page paths are unique across the UI. |
| `ctx.web.pages()` / `assets()` / `routes()` | The registrations so far, each with the plugin that made it. |
| `ctx.web.info()` | The whole seam state (`contract`, `routes`, `assets`, `pages`) - what an inventory surface shows. |
| `ctx.web.assetAt(path)` / `pageByPath(path)` | The asset/page registered for a URL path (provider lookups). |
| `ctx.web.dispatch(request)` | The route dispatch a provider calls; `undefined` when no route matched. |

A route handler is I/O free: it receives a `WebRequest` (method, path, query,
headers, `readText()`, `readJson()`) and returns a `WebResponse`. The provider
enforces the body cap and the socket, so a handler can be unit tested without a
server.

### Entrypoints and configuration

| Command | Behaviour |
| --- | --- |
| `workbench web` | Boots the kernel and reports the web state. With a `web@1` provider plugin loaded, THAT plugin serves the UI on its own port (the URL is logged by the plugin); without one the command reports the deferred state and starts no listener. |
| `workbench serve` | The long-running service mode. The core binds NO socket: it reports the web state and keeps running. `web.enabled: true` makes the section eligible; a loaded provider plugin owns the port it resolves from its own config (it also answers `/health`, or the core registers its `/health` route ON the seam when the provider answers none). |

```yaml
web:
  enabled: true      # a REQUEST: only a web@1 provider plugin can serve it
  host: 127.0.0.1    # loopback by default: the UI has no auth in this round
  port: 12348
```

Port resolution of the listener the PROVIDER binds (the plugin's own row wins):
`plugins.<provider>.port`, then `$WORKBENCH_WEB_PORT`, then `$WORKBENCH_PORT`
(the port a deployment publishes, which `serve` exports from `--port` /
`--web-port`), then the definition default `12348`. That order is what lets ONE
published port carry the UI and the `/health` the compose healthcheck probes:
publish 12347, roster the provider with `port: 12347`, and the provider answers
both while the core binds nothing.

A UI plugin is an ordinary plugin: a directory in any configured source with a
manifest (`entry`, `capabilities` - e.g. `web:page:plugin-inventory`) and an
entry module that registers its routes, assets and page. Removing it from the
config leaves the provider (and every other surface) working; removing the
PROVIDER plugin from the config leaves the core running with `web: deferred`.

## 4d. Tools capability (`ctx.tools.registerTool`)

The tools capability lives ENTIRELY in the public plugins repository
(`nexuslbs/workbench-plugins`): the Definition is `definitions/tools.ts` and the
provider is the `tools-impl` plugin, which provides `ctx.tools` and registers
the routes below on the `web@1` seam. The core ships NO tools code - no
definition, no registry, no route.

A CONSUMER plugin may register a named **tool**: a unique name, a description,
the parameters it expects (a small, JSON-Schema-compatible spec) and a handler.
The PROVIDER exposes the registered tools so ANY caller - an operator's `curl`,
the CLI, another plugin in process - invokes one BY NAME with the parameters as
the request body (the wire contract below is unchanged):

```
POST /api/tools/<name>      canonical: the JSON body IS the parameter object
GET  /api/tools             every tool: name, description, plugin, parameters
GET  /api/tools/<name>      one descriptor
POST /api/tools             alias: {"tool": "<name>", "params": { ... }}
POST /api/tool/call         the same alias, the shape the shipped omniagent
                            `workbench` MCP plugin sends ({"tool","params"})
```

Workbench has NO model and NO agent loop: this is a name -> params -> handler
invocation surface for consumers (plugins and operators), not a tool-calling
feature for an LLM. No prompt assembly, no tool-result pruning, no policy guard
in the core.

Registration returns the disposer, so it is wrapped in `ctx.effect(...)` like
every other registration:

| Field | Meaning |
| --- | --- |
| `name` | Unique tool name, e.g. `hello greet`. A duplicate is REJECTED (fail-closed, never silently overwritten); unloading the owning plugin frees the name. In a URL the name is ONE percent-encoded path segment (`hello%20greet`). |
| `description` | Human readable purpose, shown by `GET /api/tools` and `workbench tools`. |
| `parameters` | What the tool expects, DSH-style: a per-property map of `{ type, description?, required?, enum?, items?, properties? }`, `required: true` marking a property required IN ITS PARENT. `type` is one of `string`/`number`/`integer`/`boolean`/`array`/`object`/`json`. Omitted/empty means no parameters (and then any key in the body is an `unknown parameter` violation). |
| `handler(params)` | Runs with the VALIDATED parameters and returns the JSON-serialisable result (or a promise of it). It never sees an invalid body. |

`parameters` compiles to plain JSON Schema (`parameterSchemaSpecToJsonSchema` -
the shape `GET /api/tools` reports) and `validateArgs(spec, args)` returns
human-readable, path-qualified violations (`name: missing required parameter`,
`times: expected an integer, got string`, `nope: unknown parameter`).

ONE dispatch function is the single entry point for invocation + validation
(`ToolsService.execute`, reached as `ctx.tools.executeTool`): the HTTP handlers,
the CLI and any in-process caller all go through it and cannot drift.

| Status | When |
| --- | --- |
| `200` | the handler ran; body `{ status: "ok", tool, result }`. |
| `400` | the body did not satisfy the schema (`{ error: { kind: "invalid-params", violations: [...] } }`), or was not JSON (`kind: "bad-request"`) - never a silent coercion. |
| `404` | no tool with that name is registered (`kind: "unknown-tool"`), including a tool whose plugin was unloaded or disabled. |
| `500` | the handler itself threw (`kind: "tool-failed"`); the process stays up and keeps serving. |

Ownership works exactly like commands/routes/assets: the inventory reports the
owning plugin, and unloading or disabling the plugin disposes its tools with the
rest of its registrations.

Worked consumer example (the `hello-tool` plugin of the plugins repository):

```js
export function apply(ctx, config = {}) {
  ctx.effect(() => ctx.workbench.registerTool({
    name: 'hello greet',
    description: 'greets one person: required name, optional greeting and times',
    parameters: {
      name: { type: 'string', description: 'who to greet', required: true },
      greeting: { type: 'string', description: 'greeting word (default: Hello)' },
      times: { type: 'integer', description: 'how many times to greet (default: 1)' },
    },
    handler: (params) => ({ message: [...Array(params.times ?? 1)].map(() => `${params.greeting ?? 'Hello'}, ${params.name}!`).join(' ') }),
  }))
}
```

```console
$ curl -s -X POST http://127.0.0.1:12348/api/tools/hello%20greet -d '{"name":"Ada","times":2}'
{"status":"ok","tool":"hello greet","result":{"message":"Hello, Ada! Hello, Ada!"}}
```

DSH provenance: the registration shape (`ctx.tools.register` + `defineTool` with
a `ParameterSchemaSpec`), the compile step and `validateArgs` follow
`deepseek-harness` `packages/core/tools/src/schema.ts` (`:449`, `:478`) and
`packages/core/tools/src/index.ts` (`:789`). Deliberately NOT taken from DSH:
prompt assembly, model-facing schemas, the agent loop, policy guards, scoped
layers - workbench has no model.

## 4e. Email capability (`ctx.email`)

Email is the second capability that uses the three-role seam (definition,
provider, consumer), exactly like credentials (4b) and web (4c):

- **Definition** (`definitions/email.ts` in the plugins repository): the typed
  contract, the `email@1` version and the `ctx.email` handle
  (`inject: ['email']`). It names no protocol, no vendor and no mail CLI:
  an external provider must be implementable from the definition plus this
  document alone.
- **Provider**: an implementation of the contract. Its manifest declares the
  provider id it answers for - the declaration is what makes
  `ctx.email.register()` legal, and what makes the provider SELECTABLE by
  configuration:

  ```json
  {
    "name": "email-himalaya",
    "entry": "index.ts",
    "capabilities": [{ "id": "email", "version": 1, "provider": "himalaya" }]
  }
  ```

  A provider implements `accounts()`, `list(ref?, options?)` and
  `get(ref, id, options?)`. `code(ref?, options?)` and
  `search(ref, query, options?)` are OPTIONAL: the definition implements both on
  top of the required three (`code` reads the newest matching messages and
  extracts the verification code, `search` filters the envelopes), so a provider
  overrides them only when its backend can do better.
- **Consumer**: uses `ctx.email` only, never a provider module. The
  operator-facing tools are registered by the `email-tools` plugin through
  `ctx.workbench.registerTool` (4d) as `email accounts`, `email list`,
  `email get` and `email code`, reachable over HTTP like every other tool.

An account reference is a LABEL (`{ label: 'personal' }`); it never carries an
address and never a value, and an omitted reference means the provider's default
account. Where the labels, addresses and credentials come from is CONFIGURATION
(the provider's own row: `defaultAccount` + `accounts`), never the contract.

```js
export function apply(ctx, config = {}) {
  // a CONSUMER: it injects the capability and never imports a provider
  ctx.inject(['email'], (c) => {
    c.effect(() => c.workbench.registerTool({
      name: 'email code',
      description: 'the verification code of the newest matching message',
      parameters: {
        account: { type: 'string', description: 'account label (default: the provider default)' },
        query: { type: 'string', description: 'subject/from filter', required: true },
      },
      handler: async (params) => await c.email.code(
        params.account ? { label: params.account } : undefined,
        { query: params.query },
      ),
    }))
  })
}
```

The capability is covered by `npm run check:seam` (`email` joins the
`credentials` definition/provider/consumer rules; the definition imports nothing
from this package, a consumer or plugin may not import a provider module, and a
provider may not import a consumer). A working external provider (himalaya mail
CLI) plus consumer (the four tools) live in `nexuslbs/workbench-plugins`
(`plugins/email-himalaya`, `plugins/email-tools`).

The CLI is a CONSUMER of the capability, next to `ctx.workbench` and
`ctx.credentials`: `workbench email providers` prints the declared / enabled /
registered providers of `email@1` (`--json` for the raw payload) and
`workbench email accounts` prints the configured account labels and addresses of
the answering provider. Neither ever prints a credential: accounts carry a
label, an address and a default flag, never a value.
## 4f. TOTP capability (`ctx.totp`)

TOTP (time-based one-time passwords) is a capability of the same three-role shape
as credentials (4b), web (4c) and email (4e): an operator names a key once, and a
consumer asks for the CURRENT code of that name.

- **Definition** (core, `src/totp/definition.ts`, exported from `src/index.ts`):
  the typed contract, the `totp@1` version and the `ctx.totp` handle
  (`inject: ['totp']`). It names NO storage backend, NO config-file format, NO
  algorithm vocabulary beyond the contract types and no code generator: an
  external provider must be implementable from the definition plus this document
  alone. It also holds NO key material - a key never crosses the contract.
- **Provider**: an implementation of the contract. Its manifest declares the
  provider id it answers for, which is what makes `ctx.totp.register()` legal and
  what makes the provider SELECTABLE by configuration:

  ```json
  {
    "name": "totp-rfc6238",
    "entry": "index.ts",
    "capabilities": [{ "id": "totp", "version": 1, "provider": "rfc6238" }]
  }
  ```

  A provider implements `entries()` and `code(label, { at? })` only.
- **Consumer**: uses `ctx.totp` alone, never a provider module. The plugins repo
  ships `totp-tools`, which registers the tools `totp list` and `totp code`
  through `ctx.workbench.registerTool` (4d), reachable over HTTP like every
  other tool.

| Member | Meaning |
| --- | --- |
| `ctx.totp.entries()` | The configured entries as METADATA ONLY: `{ label, issuer?, account?, digits, period, algorithm, configured }`. A SECRET VALUE never appears here, in the inventory, in a log or in an error. |
| `ctx.totp.code(label, { at? })` | The CURRENT code of the entry `label`: `{ label, code, digits, period, algorithm, generatedAt, remainingSeconds }`. `at` is unix SECONDS and exists for deterministic tests and boundary checks; omitted means now. |
| `ctx.totp.providers()` / `enabled()` / `setEnabled(ids)` | The provider roster and selection, exactly as in 4b/4e (`totp.providers` in the config fixes precedence; absent enables every declared provider). |

The code is derived as RFC 6238 says: `step = floor(at / period)`, so the step
rolls over exactly at `period` boundaries and `remainingSeconds` is
`period - (at % period)` (always 1..period, the value `period` meaning the step
just started). A generator never shifts the clock; a verifier is the side that
typically accepts +/-1 step of skew (RFC 6238 section 5.2).

Errors are structured, never fatal: an unknown label is a
`TotpUnknownEntryError`-shaped error naming the label and the configured labels,
and an entry whose key cannot be resolved is a `TotpEntryNotConfiguredError`-shaped
one. Contract rule 6 applies: a plugin whose entries have no usable key stays
LOADED, reports those entries as `configured: false` and is never listed under
`failures`; only a `code()` call for such an entry fails.

The provider row (an external provider's own configuration, never the contract):

```yaml
plugins:
  totp-rfc6238:
    entries:
      github:
        secret: ${cred:TOTP_GITHUB_KEY}   # the reference form: preferred
        issuer: GitHub
        account: me@example.com
      aws-root:
        secret: JBSWY3DPEHPK3PXP          # a literal base32 key also works
        digits: 6
        period: 30
        algorithm: SHA1
```

Secrets are referenced, not written: `${cred:NAME}` is expanded by the core
before the plugin applies, and a plugin can also take a credential NAME and
resolve it at call time. Committing a real key is forbidden; the contract never
returns one (a key leaves a provider only as a generated code). The capability is
covered by `npm run check:seam` (`totp` joins the `credentials`/`email`
definition/provider/consumer rules). A working external provider (RFC 4226/6238
on `node:crypto`) plus consumer live in `nexuslbs/workbench-plugins`
(`plugins/totp-rfc6238`, `plugins/totp-tools`).

## 4g. SMS capability (`ctx.sms`)

SMS is a capability of the same three-role shape as credentials (4b), web (4c),
email (4e) and TOTP (4f): an operator configures phone numbers (one label per
number, plus an optional default), and a consumer reads the inbox of a number by
LABEL and extracts a verification code from it. The capability READS and extracts
only: it never sends an SMS, never provisions a number and never runs a webhook.

- **Definition** (core, `src/sms/definition.ts`, exported from `src/index.ts`):
  the typed contract, the `sms@1` version and the typed `ctx.sms` handle
  (`inject: ['sms']`). It names NO backend, NO API and NO credential format: a
  number reference is a LABEL (an operator name such as `personal`), never a
  phone number and never a secret. An external provider must be implementable
  from the definition plus this document alone. The `code()` and `search()`
  algorithms live on the definition (like 4e), so every backend gets them.
- **Provider**: an implementation of the contract; its manifest declares the
  provider id it answers for, which is what makes `ctx.sms.register()` legal and
  what makes the provider SELECTABLE by configuration:

  ```json
  {
    "name": "sms-twilio",
    "entry": "index.ts",
    "capabilities": [{ "id": "sms", "version": 1, "provider": "twilio" }]
  }
  ```

  A provider implements `numbers()`, `list()` and `get()`; `code()` and
  `search()` are optional (a backend that answers them natively overrides the
  definition algorithms).
- **Consumer**: uses `ctx.sms` alone, never a provider module. The plugins repo
  ships `sms-tools`, which registers the tools `sms numbers`, `sms list`,
  `sms get` and `sms code` through `ctx.workbench.registerTool` (4d), reachable
  over HTTP like every other tool.

| Member | Meaning |
| --- | --- |
| `ctx.sms.numbers()` | The configured numbers as METADATA ONLY: `{ label, number?, default?, configured? }`. The label is the reference every other method takes; `number` is the TO number of the inbox and a provider may omit it. No secret appears here. |
| `ctx.sms.list(ref?, { limit?, since?, unreadOnly?, from? })` | The newest INBOUND messages of the number `ref` (the configured default number when omitted), newest first: `{ id, from, to, date, body, status?, unread? }[]`. `limit` defaults to 10 and is hard-capped at 100; a body is capped at 2000 characters and marked when cut. |
| `ctx.sms.get(ref?, id)` | One message by its provider id (for Twilio: the message `Sid`), with its (capped) body and envelope. |
| `ctx.sms.code(ref?, { id?, query?, pattern?, occurrences?, maxAgeSeconds? })` | The verification code: `{ code, body, from, date, messageId }`. Digits-first 4-8 digits, alphanumeric fallback; `pattern` overrides the shape (group 1, or the whole match); `occurrences` picks the Nth candidate; `id` short-circuits the scan to one message; `query` filters on sender or body; `maxAgeSeconds` bounds how old the message may be. |
| `ctx.sms.search(ref?, query, { limit? })` | Messages whose sender or body contains `query` (a provider with native search answers better). |
| `ctx.sms.providers()` / `enabled()` / `setEnabled(ids)` | The provider roster and selection, exactly as in 4b/4e/4f (`sms.providers` in the config fixes precedence; absent enables every declared provider). |

Errors are structured, never fatal: an unknown label names the label and the
configured ones (`SmsUnknownNumberError`), a label whose credential did not
resolve is a `SmsNumberNotConfiguredError`, a missing message or code is a
`SmsNotFoundError`, and calling any method with no provider at all is a
`SmsNotConfiguredError`. Contract rule 6 applies: a provider whose credential is
missing stays LOADED and is reported as not-configured (never under `failures`);
only a call fails.

The provider row (an external provider's own configuration, never the contract),
one entry per number LABEL, each with its own credentials, so numbers MAY live in
different accounts:

```yaml
plugins:
  sms-twilio:
    defaultNumber: personal
    numbers:
      personal:
        number: "+15551234567"          # the TO number whose inbox is read
        accountSid: ACxxxxxxxx           # not a secret; ${cred:NAME} also works
        authToken: TWILIO_PERSONAL_TOKEN # a credential NAME (or ${cred:NAME})
      work:
        number: "+15557654321"
        accountSid: ACyyyyyyyy
        authToken: TWILIO_WORK_TOKEN
```

Secrets are referenced, not written: `authToken` is a credential NAME or the
core's `${cred:NAME}` spelling, and `accountSid` is a literal unless it carries a
reference of its own. A provider row configures the plugin and is applied BEFORE
the kernel's `${cred:NAME}` expansion, so a provider resolves a reference itself
at CALL time through `ctx.credentials`. The NAME form is the one that keeps a
config BOOTABLE with an empty credential store: the kernel expands
`${cred:NAME}` before the plugins load and an unresolvable one is FATAL, whereas
a NAME that does not resolve leaves the plugin loaded with that number
not-configured. Committing a real token is forbidden and no token crosses the
contract. The capability is covered by `npm run check:seam` (`sms` joins the
`credentials`/`email`/`totp` rules). A working external provider (Twilio REST,
API version `2010-04-01`) plus consumer live in `nexuslbs/workbench-plugins`
(`plugins/sms-twilio`, `plugins/sms-tools`).

## 5. How an external source is added

The core config (JSON `workbench.config.json` or YAML `workbench.config.yml` /
`workbench.config.yaml`; the extension selects the parser) lists sources:

```json
{
  "sources": [
    { "kind": "path", "id": "workbench-plugins", "path": "../workbench-plugins/plugins" },
    { "kind": "path", "id": "external-plugins", "path": "../example-plugins/plugins" },
    { "kind": "git", "id": "external-plugins-git", "url": "https://github.com/example/example-plugins.git", "ref": "main", "subdir": "plugins" }
  ],
  "plugins": { "hello-otherworld": { "message": "Hello Otherworld" } }
}
```

- `path` sources are local directories (`path` relative to the config file).
- `git` sources are cloned/fetched into `$WORKBENCH_CACHE_DIR/<id>` (default
  `<config dir>/.workbench/sources/<id>`; git is required) and then scanned like
  a path source (`subdir` selects the plugin directory). `ref` accepts a branch,
  a tag or a commit sha (default: the remote HEAD). The first use clones into a
  staging directory and renames it into place, so an interrupted clone can never
  be scanned (and a leftover directory that is not a checkout is removed before
  cloning); later runs `fetch` and force a detached `checkout` of the same ref.
  A source that fails to resolve is reported with its id, url, ref and git's own
  stderr - and SKIPPED, so stale code is never loaded silently. The resolved
  checkout path is part of the loader inventory (`workbench plugins`, `--json`).
- `external: false` marks a core source; every other source is external and is
  skipped by `--no-external`.
- Without `--config` the core looks for `workbench.config.yml`, then
  `workbench.config.yaml`, then `workbench.config.json` in the working directory
  (and then next to the core) and uses the first one that exists. Both formats
  share the schema, the validation and the `${env:VAR}` expansion; YAML scalars
  are typed, so quote values that must stay strings.

There is no per-plugin registration code: dropping a plugin directory into a
configured source is the whole wiring. The loader is directory-driven, so a new
plugin in an already-configured external source is picked up without any
core change (no config entry needed beyond the source itself).

## 6. What must not be in the core

The core is a host: cordis boot, source resolution, manifest discovery/loading,
the command registry and the CLI. Anything that does actual work (deployments,
publishing, providers, ...) belongs to a plugin. If a feature cannot be expressed
as a plugin, the plugin contract - not the core - is what has to change.

## Private sources (`git` + `auth`): a plugin repository that is not public

A `git` source may declare `auth`, a credential REFERENCE (a NAME, never a value):

```yml
sources:
  - kind: git
    id: workbench-plugins-private
    url: https://github.com/nexuslbs/workbench-plugins-private
    ref: main
    subdir: plugins
    auth:
      type: github-app
      credential: GITHUB_APP_KEY   # a NAME; a credentials provider plugin resolves it
      appId: 3967918
      installationId: 138119822
```

Contract:

- The credential is resolved BEFORE the fetch, through the credentials service,
  by a PROVIDER PLUGIN (the core ships none). The kernel therefore resolves the
  credential-free sources first - that is where the provider plugin comes from
  (e.g. the PUBLIC `plugins/credentials-basic`) - and only then resolves the
  `auth` sources. A credential-dependent source with NO provider loaded is
  DEFERRED (reported, no crash, no anonymous fetch); once a provider registers,
  it becomes eligible in the same boot. See `docs/CREDENTIALS.md` section 6.
- The credentials PHASE (phase 1 above) also loads every plugin that declares the
  `credentials` capability WITHOUT a `provider` id - a GIT AUTH STRATEGY plugin
  such as `plugins/credentials-github-app`. The handler for `auth.type` must be
  registered before the gated source is resolved, so a strategy plugin must be
  reachable from a credential-free source too.
- `type: token` (default) sends the value as a basic-auth `http.extraheader`;
  `type: github-app` treats the value as an App PRIVATE KEY (PEM) and mints a
  short-lived installation token (RS256 JWT -> `POST /app/installations/{id}/access_tokens`).
- The credential is TRANSIENT: `-c credential.helper=` plus
  `-c http.extraheader=...` on that single git command; the checkout's
  `.git/config` keeps the plain configured url, no credential file is written, and
  git arguments in errors/logs are redacted.
- Everything else about `git` sources is unchanged (branch/tag/sha `ref`,
  `subdir`, staged first clone, in-place update, per-source error reporting and
  the loader inventory line).
- A source that declares `auth` is never fetched anonymously: when its credential
  is missing or wrong, the source is reported as an error
  (`source '<id>' (git <url> @ <ref>): authentication failed: ...`) and SKIPPED,
  while the other sources still load. A source may be PRIVATE while its plugin
  contract stays the same as any other external plugin - no core-internal reach.
- The key material is operator-provided at runtime and referenced by name only:
  NEVER commit a PEM, token or generated credential file.

Config shape (types): `SourceSpec.auth: { type?: 'token' | 'github-app';
credential: string; username?: string; appId?: number | string;
installationId?: number | string; apiBase?: string }`.

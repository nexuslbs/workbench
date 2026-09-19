# workbench plugin contract

This is the contract every workbench plugin follows, core plugins and external
plugins alike (the core loads both through the same mechanism). It is
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
consumer) - see [CREDENTIALS.md](CREDENTIALS.md) for the full contract and the
four core providers (`env`, `file`, `project-env`, `user-env`):

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

The Web UI is composed ONLY of plugins. The core knows how to SERVE bytes and
how to route them - it ships no page, no router, no template engine and no UI
framework. This is the same three-role seam as credentials
(`Provider -> Definition <- Consumer`, `web@1`):

- **Definition** (core, `src/web/definition.ts`, exported from `src/index.ts`):
  the typed contract plus the `Web` service handle. It touches no socket and no
  file.
- **Provider**: the serving side. The core ships exactly one,
  `src/web/providers/http.ts` (a `node:http` server wired by the composition
  root `src/kernel.ts`); it is the only core module that touches a socket. It
  serves, in order: the minimal core shell (`/`, any registered page path,
  `/shell.css`, `/shell.js`), the static assets plugins registered (read from the
  plugin directory on every request), the routes plugins registered, then a JSON
  404. Everything it registers (`GET /api/web/pages`, the shell assets) is
  disposed when the server is closed.
- **Consumer**: a UI plugin. It registers routes/assets/pages through `ctx.web`
  and never imports a provider.

`inject: ['web']` is required to touch the seam. Every registration returns its
disposer, so wrap it in `ctx.effect(...)` and unloading the plugin removes its
routes, assets and pages cleanly (proved by `test/web.test.ts`).

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
| `workbench web` (or `npm run web`) | Boots the kernel and starts the Web UI listener (the serve/loader seam only). Prints the URL. |
| `workbench serve` | The long-running service mode (status endpoint on `--port`/`$WORKBENCH_PORT`, default 12347). When the config sets `web.enabled: true` the SAME process also starts the Web UI listener - one long-running process, not a second mode. |

```yaml
web:
  enabled: true      # serve also starts the Web UI (absent/false keeps today's behaviour)
  host: 127.0.0.1    # loopback by default: the UI has no auth in this round
  port: 12348
```

Resolution order: flag (`--host`, `--port`), then environment
(`$WORKBENCH_WEB_HOST`, `$WORKBENCH_WEB_PORT`), then the config, then the
documented defaults `127.0.0.1:12348`. With no UI plugin configured the server
still boots and serves the empty shell ("no pages registered"); the CLI surfaces
(`hello`, `plugins`, `commands`, `credentials`) are unchanged.

A UI plugin is an ordinary plugin: a directory in any configured source with a
manifest (`entry`, `capabilities` - e.g. `web:page:plugin-inventory`) and an
entry module that registers its routes, assets and page. Removing it from the
config leaves the server (and every other surface) working.

## 4d. Tools capability (`ctx.workbench.registerTool`)

A CONSUMER plugin may register a named **tool**: a unique name, a description,
the parameters it expects (a small, JSON-Schema-compatible spec) and a handler.
The core exposes the registered tools so ANY caller - an operator's `curl`, the
CLI, another plugin in process - invokes one BY NAME with the parameters as the
request body:

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
(`ToolRegistry.execute`, reached as `ctx.workbench.executeTool`): the HTTP
handlers, the CLI and any in-process caller all go through it and cannot drift.

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

## 5. How an external source is added

The core config (JSON `workbench.config.json` or YAML `workbench.config.yml` /
`workbench.config.yaml`; the extension selects the parser) lists sources:

```json
{
  "sources": [
    { "kind": "path", "id": "core", "path": "./plugins", "external": false },
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
      credential: GITHUB_APP_KEY   # resolved by the BOOTSTRAP credential set
      appId: 3967918
      installationId: 138119822
```

Contract:

- The credential is resolved BEFORE the fetch, by the BOOTSTRAP set (core
  providers `env`, `file`, `project-env`, `user-env`, selected/ordered by
  `credentials.bootstrap`) - never by a plugin-provided provider, because source
  resolution happens before plugin discovery. See `docs/CREDENTIALS.md`.
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

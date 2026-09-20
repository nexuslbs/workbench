# workbench (core)

workbench is the **agent equipment layer**: a minimal plugin host plus a
documented plugin contract. The core itself contains **no product feature** - it
only discovers plugins from configured sources, loads them into a
[cordis](https://github.com/cordiverse/cordis) context, and runs the commands
they register. Everything else is a plugin.

- Core: this repository (`nexuslbs/workbench`).
- Plugins: [`nexuslbs/workbench-plugins`](https://github.com/nexuslbs/workbench-plugins),
  consumed as an **external** plugin source. Its source is never copied into this repo.

Stack: Node + TypeScript on cordis, no build step (Node >= 22.18 strips the types).

## Requirements

- Node >= 22.18 (TypeScript type stripping, ESM)
- npm
- git (only for `git` plugin sources)

## Quickstart

```bash
git clone https://github.com/nexuslbs/workbench.git
cd workbench
npm install
npm test
```

The core repo SHIPS ZERO PLUGINS (v0.0.2): its default config
(`workbench.config.yml`) declares no plugin source and no roster row, so a fresh
checkout boots with 0 plugins loaded and an EMPTY inventory. No plugin
repository is required - and none is vendored: every plugin comes from an
external source (`nexuslbs/workbench-plugins`).

```bash
npm run dev -- plugins         # empty inventory: 0 plugin(s) loaded
npm run dev -- serve           # long-running service mode (see below)
```

Raw output of the documented smoke command:

```console
$ npm run dev -- plugins
workbench: 0 plugin(s) loaded (0 core, 0 external), 0 available (not on the plugins: roster), 0 disabled, 0 failed
```

Load plugins by declaring an EXTERNAL source in your config (consumed as an
external source, never vendored into this repo) - a sibling checkout
(`kind: path`) or, in production, a git coordinate (`kind: git`) - and name the
plugins you want in the `plugins:` roster:

```yaml
sources:
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins
  # production shape:
  # - kind: git
  #   id: workbench-plugins
  #   url: https://github.com/nexuslbs/workbench-plugins
  #   ref: main
  #   subdir: plugins

plugins:
  hello-world: { message: Hello World }   # the roster: only these are LOADED
```

```bash
npm run dev -- --config /path/to/that/config.yml plugins
npm run dev -- --config /path/to/that/config.yml hello world   # -> Hello World
CONFIG_FILE=/path/to/that/config.yml npm run dev -- plugins     # same thing
```

A PRIVATE git source carries a credential REFERENCE BY NAME, never a value. The
core ships NO credential provider, so the value is resolved through the
credentials SERVICE, whose provider is a PLUGIN (`credentials-basic`): the kernel
walks the credential-FREE sources FIRST (that is where the provider plugin comes
from) and DEFERS an `auth` source until a provider plugin has been registered in
the same boot (see [docs/CREDENTIALS.md](docs/CREDENTIALS.md), section 6):

```yaml
sources:
  - kind: git
    id: workbench-plugins-private
    url: https://github.com/nexuslbs/workbench-plugins-private
    ref: main
    subdir: plugins
    auth:
      type: github-app
      credential: GITHUB_APP_KEY     # the value never appears in a file
      appId: 3967918
      installationId: 138119822
```

Plugin loading messages go to stderr, command output to stdout.

## Service mode (`serve`)

`workbench serve` boots the plugins, REPORTS the web state and stays up until
`SIGINT`/`SIGTERM`. The core binds NO socket of its own: the ONLY listener is
the one a `web@1` PROVIDER plugin brings up (see the Web UI section below). It
is what the compose service runs, so the container is `Up` because the plugin
that serves it answered, not because the core sleeps.

```console
$ npm run dev -- serve
workbench: web state=off - no web@1 provider plugin is loaded and this process binds no port
workbench: 0 plugin(s) loaded (0 core, 0 external), 0 available (not on the plugins: roster), 0 disabled, 0 failed
```

With `web.enabled: true` and no provider plugin the state is `deferred`
(`workbench: web is DEFERRED - no plugin providing web@1 is loaded ...`): still
no port, no crash, and the process keeps running.

Environment (all optional):

| Variable | Meaning |
| --- | --- |
| `CONFIG_FILE` | Config file to use when `--config` is not given; empty/unset = the default lookup described below. |
| `WORKBENCH_CONTROL_SOCKET` | Path of the OUT-OF-BAND control socket `serve`/`web` serve (default `<tmpdir>/workbench-control-<hash of the config path>.sock`). See "Applying a config change to a RUNNING process". |
| `WORKBENCH_PORT` | The port a DEPLOYMENT publishes; `serve` exports it (and `--port` / `--web-port`) into the environment the web provider plugin reads. The core binds nothing itself. |
| `WORKBENCH_CACHE_DIR` | Where `git` plugin sources are checked out (default `<config dir>/.workbench/sources`). |
| `WORKBENCH_SOURCE_INSTALL` | `off` disables the DEPENDENCY PROVISIONING of `git` sources (reported as `skipped`, never as a silent success). Unset/anything else = provision when a checkout's `node_modules` is missing or its lockfile changed (see "Changing a source `ref` on a LIVE process"). |
| `WORKBENCH_NPM` / `WORKBENCH_PNPM` / `WORKBENCH_YARN` | The package-manager binaries the provisioning step runs (default `npm` / `pnpm` / `yarn`). |

## Applying a config change to a RUNNING process

The config file is read **once, at boot**: editing it does NOT change a process
that is already running, and the core implements no signal reload and no watcher
of its own. A change reaches a running process in three ways, plus a restart:

1. **In-process, when the roster loaded a management plugin**: the
   `plugin-manager` HTTP action (or the Web UI using it) calls the core's
   `host.reconcile()`: the desired `plugins:` roster is diffed against the live
   tree and ONLY the delta is applied (load / unload / reload / park).
2. **Live, through a config-watch plugin**: a roster entry such as `config-watch`
   (from `nexuslbs/workbench-plugins`) notices an external edit of the file and
   runs `reloadConfig()` + `host.reconcile()` on the running process.
3. **Out-of-band, with NO plugin and NO HTTP route at all**:

   ```console
   $ docker exec <container> node dist/cli.js reconcile
   workbench: the RUNNING process (pid 1) applied the config change out-of-band via /tmp/workbench-control-3f1c0a9b77d2.sock
   workbench: reconcile: 25 desired, 4 loaded, 2 change(s)
     plugin-manager: load - desired and not loaded
     hello-world: unchanged - already loaded with the same config
     ok=true loaded=6 deferred=none errors=none
   ```

   The CLI resolves the config file the SAME way the boot does (`--config` ->
   `CONFIG_FILE` -> default lookup), derives the control socket of the process
   that owns THAT config, and asks the RUNNING process to converge - which it
   does with the very same `host.reconcile()`. Nothing is persisted: the config
   file is the input. With no live process the command converges a ONE-SHOT
   process instead (and says so); `--local` forces that and never touches a
   running process. `--json` prints the full per-plugin report; the exit code is
   `1` when a row failed to converge, while the other rows still converged.

A restart works too and remains the fallback.

### Changing a source `ref` on a LIVE process

A source is re-resolved on every scan (boot, `host.reconcile()`, `install`), so
bumping a `git` source `ref` - or moving the branch/tag it points at - is a
supported LIVE operation:

```console
$ # edit the config file: sources[].ref: v0.0.7 -> v0.0.8
$ docker exec <container> node dist/cli.js reconcile
```

What the loader guarantees for that path:

- **one identity per SOURCE, not per file.** Every module a source resolves - the
  plugin ENTRY *and* every relative helper it imports, at any depth - carries the
  same identity (`?wb=<id>`), applied by a loader-owned module RESOLVE hook. The
  identity is the resolved COMMIT of a `git` checkout plus a content fingerprint
  of the tree, and the in-place `fetch` + `checkout --force --detach` of a ref
  bump moves the WHOLE graph at once: "the new entry imports a stale helper" (the
  failure mode that produced `does not provide an export named
  'CHALLENGE_ACTIONS'`) cannot happen, and a reconcile re-imports the new code
  with no restart and no cache-dir surgery.
- **an UNCHANGED source keeps its identity**, so its URLs and modules are reused
  (no re-evaluation, no module-map growth): the `reload` contract of an unchanged
  plugin is exactly what it was.
- **code ON DISK is enough.** The fingerprint hashes file CONTENT, so patching an
  entry or a helper in place (same size, same second) is picked up by the next
  `reload` / `reconcile` too - the historical "a code-level patch reaches a
  running process" contract, now covering the whole graph.
- **drift is reported.** A source whose LOADED code no longer matches the code on
  disk is one of the drift sources (`sourceGraphs()` in the reports), which is
  why a reconcile re-imports it even when no roster row changed.
- **dependencies are provisioned by the source, not by hand.** When a checkout has
  a `package.json`, resolution runs the package manager its LOCKFILE names
  (`npm ci --omit=dev` for an npm checkout, `pnpm install --frozen-lockfile
  --prod`, `yarn install --frozen-lockfile --production=true`; the binaries are
  overridable with `WORKBENCH_NPM` / `WORKBENCH_PNPM` / `WORKBENCH_YARN`) in the
  checkout root, but ONLY when `node_modules` is missing or the lockfile /
  `package.json` changed since the last successful install. A marker NEXT TO the
  checkout records that install, so a converged deployment needs no network and
  no install on the next boot. A FAILING install is a TYPED diagnostic naming the
  exact command and directory -
  `source-dependencies-unavailable: 'npm ci --omit=dev' failed in <dir> ...;
  run 'npm ci --omit=dev' in <dir> by hand, or set
  WORKBENCH_SOURCE_INSTALL=off ...` - instead of surfacing later as a silent
  `provider-unavailable` inside one plugin. `WORKBENCH_SOURCE_INSTALL=off` is the
  explicit opt-out (reported as `skipped`, never as a silent success).

What an operator may and must not do: changing a source COORDINATE (`url`, `ref`,
`subdir`) in the config and reconciling is the supported way to ship new plugin
code, and a restart is never needed for it. The cache directory itself belongs to
the loader: a manual `git checkout` or `npm ci` inside it is redundant (the next
resolve re-checks out and re-provisions) and can race a fetch. Nothing must be
copied into a checkout by hand, and `node_modules` must never be committed to a
plugin repository.

### `workbench sources update|list`: refreshing the sources ON PURPOSE

The two operations above are how a *config change* reaches a running process.
This one is the explicit entry point for "the sources moved, pull them": it
refreshes the SOURCE CHECKOUTS themselves, with no config edit and no restart.

Real output, on a config with TWO sources: a `path` fixture source `core`
(`/opt/workbench/plugins`, holding `hello-world`) and a local git source `demo`
(`/srv/git/demo-plugins`, ref `main`). Only the pid, the socket path and the
commit shas are environment-specific: every line below is verbatim output.

```console
$ node dist/cli.js sources list --config /opt/workbench/workbench.config.yml
workbench: the RUNNING process (pid 1087) refreshed the plugin sources out-of-band via /tmp/wb2681.sock
listed 2 source(s) from /opt/workbench/workbench.config.yml: 0 changed, 0 plugin(s) re-imported, 0 error(s); no config write, no restart
  core (path): unchanged at (none)
    dir: /opt/workbench/plugins  deps: none
    plugins: hello-world
  demo (git, /srv/git/demo-plugins, ref main): unchanged at 3629bbd5f643
    dir: /var/lib/workbench/sources/demo/plugins  deps: none
    plugins: git-demo
  ok=true persisted=false operation=list changed=none re-imported=none errors=none

$ node dist/cli.js sources list --config /opt/workbench/workbench.config.yml --local --id core
listed 1 source(s) from /opt/workbench/workbench.config.yml: 0 changed, 0 plugin(s) re-imported, 0 error(s); no config write, no restart
  core (path): unchanged at (none)
    dir: /opt/workbench/plugins  deps: none
    plugins: hello-world
  ok=true persisted=false operation=list changed=none re-imported=none errors=none

$ node dist/cli.js sources update --config /opt/workbench/workbench.config.yml --local --id core
sources update failed: source 'core' is a 'path' source: there is nothing to fetch (a path source IS the directory the config names)
  ok=false persisted=false operation=update changed=none re-imported=none errors=none

$ node dist/cli.js sources update --config /opt/workbench/workbench.config.yml
workbench: the RUNNING process (pid 1087) refreshed the plugin sources out-of-band via /tmp/wb2681.sock
updated 1 source(s) from /opt/workbench/workbench.config.yml: 1 changed, 1 plugin(s) re-imported, 0 error(s); no config write, no restart
  demo (git, /srv/git/demo-plugins, ref main): 3629bbd5f643 -> 314623cd0cd8 CHANGED
    dir: /var/lib/workbench/sources/demo/plugins  deps: none
    plugins: git-demo
    re-imported: git-demo
  ok=true persisted=false operation=update changed=demo re-imported=git-demo errors=none
```

(The `update` above ran while a workbench process was serving that config; the
`demo` plugin was re-imported from the moved checkout and answered with the NEW
code with no restart. A second `sources update` in a row prints `unchanged at
314623cd0cd8` and re-imports nothing.)

- **`update`** (the default selection is every `kind: git` source; `--id
  <source-id>` limits it to one, repeatable): fetch + `checkout --force --detach`
  of the ref the CONFIG declares, in the same checkout directory, through the
  SAME `resolveSource` path the boot and `reconcile` use - never a second fetch
  implementation. It then provisions the checkout's dependencies (the command its
  lockfile names, exactly as described above) and re-imports the plugins whose
  code moved under the process through the loader's module-graph drift pass, so
  the NEW code answers with no restart.
- **`list`** reads only: no fetch, no install, no import. It covers EVERY
  configured source - a `path` source is reported with its directory, its
  dependency state and the plugins it provides, and with `url` / `ref` /
  `resolvedCommit` all `null` and `changed: false` - and reports the checkout
  directory, the resolved commit (`git rev-parse HEAD`) and the dependency state
  read from disk (`provisioned` / `stale` / `missing` / `none`). `--id
  <source-id>` works for any of them, `path` sources included. A TARGETED walk
  (`--id`) keeps the discoveries of the sources it did NOT walk, so refreshing
  one source never makes another source's plugins vanish from the report.
- **The config file is the truth.** There is deliberately NO `--ref` (or any
  other source-coordinate) override: a refresh can only fetch the `url`/`ref` the
  config declares, so it can never leave the process serving something the file
  on disk does not say. To move a source, edit the config `ref` (or push a new
  commit on the configured branch ref) and run `sources update`.
- **Nothing is persisted**: unlike `install` / `uninstall`, this operation never
  writes the config file (`persisted: false`, and the file is byte-identical
  afterwards). `--local` converges a ONE-SHOT process instead of the running one;
  with no live process the command falls back to that one-shot and SAYS so.
- **Reachability**: like `reconcile`, the default reaches the running process
  through the core's control socket, so it works on a MINIMAL roster (no
  management plugin, no HTTP route, no extra port). The op is `sources-update`
  next to `ping` / `inventory` / `reconcile`. `--json` prints the full report;
  the exit code is `1` when a source failed (the others still ran) and `2` on a
  bad invocation (a missing/unknown subcommand is never a silent `update`).
- **Relationship to `reconcile`**: `host.reconcile()` - and therefore the
  `config-watch` plugin and the `plugin-manager` action - ALREADY re-resolves
  every configured source as part of a roster converge, which is why a source
  `ref` bump is applied by `reconcile` too. `sources update` is the EXPLICIT,
  roster-independent entry point for the same refresh: it reports per source
  `ref` -> commit moves, provisions the checkout, and refreshes even when
  nothing in `plugins:` changed. Use it when you want the source pull to be the
  operation, not a side effect of a converge.
- **What it does NOT do**: no restart, no container lifecycle, no config write,
  no `plugins:` roster change, no dependency install outside the source
  checkout. `update` refuses a `path` source and an unknown `--id` BY NAME (there
  is nothing for a fetch to do: a path source IS the directory the config
  names), while `list` covers every configured source - so what a fetch cannot
  apply to is still reported, never hidden. A failing source is a typed
  diagnostic naming id + url + ref + git's stderr while the other sources still
  refresh.

When to run it: a `ref` bump, a new commit on a branch ref such as `main`, a
wiped cache volume (it re-clones), or a checkout whose `node_modules` is missing
or stale.

### Why the CORE serves that channel

The in-process mutation surface of a deployment **is itself plugins**
(`plugin-manager`, `settings`, `plugin-inventory` and the `web@1` provider that
hosts their routes). A MINIMAL roster therefore boots a process with NO action to
call at all: the `/api/plugin-manager/action` route simply does not exist and
nothing can be loaded, so a restart used to be the only way out. To keep the
converge operation reachable on such a process, the core serves a **unix domain
socket** while `serve` / `web` run: `$WORKBENCH_CONTROL_SOCKET` or
`<tmpdir>/workbench-control-<hash of the config path>.sock`, mode `0600`,
newline-delimited JSON with `ping` / `inventory` / `reconcile`. No TCP port, no
HTTP server, no plugin is involved - the core still owns no listener a product
needs, and nothing a deployment serves goes through it. ONE process owns the
socket: a LIVE channel is never stolen by a second boot (it logs that and keeps
running without one), while a stale socket FILE from a killed process is taken
over.

`GET /health`, `/api/plugins` and `workbench plugins` report the state
explicitly as `mutationSurface: { loaded, listener, providers, candidates,
controlSocket, remedy }` - `loaded: false` plus the one-line `remedy` is what
tells an operator that this process needs the out-of-band converge (or a
restart). Detection is generic, from the manifest capabilities: a `web@1`
PROVIDER plugin is the `listener`, a plugin declaring `web:page:*` /
`web:route:*` is a management plugin, and the `candidates` are the discovered
plugins that would provide the surface. The boot log says the same in one line:

```console
workbench: 2 plugin(s) loaded of 25 rostered (23 available, 0 disabled, 0 failed); mutation surface: NONE - the process has NO in-process mutation surface (no loaded plugin declares a management page/route): add plugin-manager / plugin-inventory / settings / web-impl to the 'plugins:' roster of <config> and apply it OUT-OF-BAND with 'workbench reconcile' (control socket <socket>), or restart the process
```

## Web UI (`web`)

`workbench web` (or `npm run web`) boots the kernel and starts a browser UI on
`127.0.0.1:8080` by default. The core serves bytes and routes them; every page
comes from a plugin through the `ctx.web` seam (see
[docs/PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md) section 4c). With no UI
plugin configured the server still boots and serves the empty shell.

```console
$ npm run web -- --port 8080
workbench: web UI on http://127.0.0.1:8080 (config <path>)
```

- Bind: `--host` / `--port` flag, then `$WORKBENCH_WEB_HOST` / `$WORKBENCH_WEB_PORT`,
  then the `web:` section of the config, then `127.0.0.1:8080`.
- `workbench serve` (the service mode) reports the WEB state: with a web PROVIDER
  PLUGIN loaded (from an external source) that plugin owns the published port -
  the browser UI, its shell/assets/routes AND `/health` all answer on it. With
  `web.enabled: true` and NO provider plugin the section is DEFERRED: the core
  logs the state, binds NOTHING and keeps running (there is no core listener to
  fall back to, by design).
- No auth this round: the default bind is loopback on purpose. Binding a
  non-loopback host exposes the UI to everyone who can reach it.

## Tools API

A plugin registers a named tool (a description, the parameters it expects and a
handler) through `ctx.tools.registerTool` - the `tools@1` capability is a PLUGIN
(the `tools-impl` provider, Definition in `definitions/tools.ts`, both from the
public plugins repository), never core code. The provider registers the by-name
invocation routes below on the `web@1` seam, with the parameters as the request
body. Workbench has no model and no agent loop: the callers are plugins and
operators. The full contract is
[docs/PLUGIN-CONTRACT.md](docs/PLUGIN-CONTRACT.md) section 4d.

| Route | Behaviour |
| --- | --- |
| `GET /api/tools` | every registered tool with `name`, `description`, `plugin` and its parameter schema. |
| `GET /api/tools/<name>` | one tool descriptor. The name is ONE percent-encoded path segment: `/api/tools/hello%20greet`. |
| `POST /api/tools/<name>` | invoke it - the JSON body IS the parameter object. |
| `POST /api/tools` | alias: body `{"tool":"<name>","params":{...}}`. |
| `POST /api/tool/call` | the same alias, served for the shipped omniagent `workbench` MCP plugin. |

Status: `200` + `{"status":"ok","tool","result"}`; `400` +
`{"error":{"kind":"invalid-params","violations":[...]}}` for a body that does
not satisfy the schema (missing required, wrong type, unknown parameter) and
`kind: "bad-request"` for a malformed body; `404` +
`{"error":{"kind":"unknown-tool"}}`; `500` +
`{"error":{"kind":"tool-failed"}}` when the handler throws - the process keeps
serving. A validation failure is never a silent coercion and never a 500.

```console
$ curl -s http://127.0.0.1:8080/api/tools
{"status":"ok","contract":"tools@1","count":1,"tools":[{"name":"hello greet","description":"greets one person: required name, optional greeting and times","plugin":"hello-tool","parameters":{"type":"object","properties":{"name":{"type":"string"},"greeting":{"type":"string"},"times":{"type":"integer"}},"required":["name"]}}]}

$ curl -s -X POST http://127.0.0.1:8080/api/tools/hello%20greet -d '{"name":"Ada","times":2}'
{"status":"ok","tool":"hello greet","result":{"message":"Hello, Ada! Hello, Ada!"}}

$ curl -s -X POST http://127.0.0.1:8080/api/tools/hello%20greet -d '{}'
{"status":"error","error":{"kind":"invalid-params","message":"invalid params for tool 'hello greet': name: missing required parameter","tool":"hello greet","violations":["name: missing required parameter"]}}

$ curl -s -X POST http://127.0.0.1:8080/api/tool/call -d '{"tool":"hello greet","params":{"name":"Ada"}}'
{"status":"ok","tool":"hello greet","result":{"message":"Hello, Ada!"}}

$ curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:8080/api/tools/nope
404
```

## CLI

| Command | Description |
| --- | --- |
| `workbench serve` | Boot the plugins and keep running (service mode). The core binds NO port: with a `web@1` provider plugin loaded that plugin serves the Web UI and `/health` on the port it resolves (`WORKBENCH_PORT`, `--port` / `--web-port`). |
| `workbench web` | Boot the plugins and serve the plugin-composed Web UI (default `127.0.0.1:8080`). |
| `workbench <command> [args...]` | Run the command registered by a plugin (longest match wins, the rest becomes args). |
| `workbench plugins` | List loaded plugins, their source and their capabilities. |
| `workbench commands` | List the registered commands (and the plugin that registered them). |
| `workbench tools` | List the registered tools WITH their parameter schema and owning plugin (registered by the `tools-impl` plugin). |
| `workbench tool <name> ['<json params>']` | Invoke one tool through the same dispatch the HTTP routes use (provided by the `tools-impl` plugin; `workbench tool 'hello greet' '{"name":"Ada"}'`); invalid params exit `2`, an unknown tool exits `1`. |
| `workbench plugins --json` / `workbench commands --json` | Machine-readable variants. |
| `--config <file>` | Use another config file; `.json`, `.yml` or `.yaml` (the extension selects the parser). |
| `--port <n>` | Exported as `$WORKBENCH_PORT` for the web provider plugin (the core binds nothing). |
| `--web-port <n>` | Exported as `$WORKBENCH_WEB_PORT` for the web provider plugin (the plugin resolves the port). |
| `--no-external` | Skip external sources (with the shipped default config nothing loads at all). |
| `--help` | Usage. |

With npm: `npm run dev -- <args>`.

## Config (`workbench.config.yml` / `.yaml` / `.json`)

The same schema is read from **JSON or YAML** - the file extension selects the
parser (`.json` -> JSON, `.yml` / `.yaml` -> YAML; any other extension is an
error, the core never guesses). Without `--config` the core looks for, in order,
`workbench.config.yml`, `workbench.config.yaml`, `workbench.config.json` in the
working directory and then next to the core; the first existing file wins and a
missing config names all three candidates.

YAML, with comments - this is the shipped default: NO plugin at all, with the
external sources as commented EXAMPLES (the core never depends on a plugin
repository):

```yaml
# workbench.config.yml
sources: []

# EXAMPLE - external repositories of plugins:
# - kind: path
#   id: workbench-plugins
#   path: ../workbench-plugins/plugins
# - kind: git
#   id: workbench-plugins
#   url: https://github.com/nexuslbs/workbench-plugins
#   ref: main
#   subdir: plugins

plugins: {}
```

The same schema in JSON (JSON has no comments, so an external source is a real
entry there):

```json
{
  "sources": [{ "kind": "path", "id": "workbench-plugins", "path": "../workbench-plugins/plugins" }],
  "plugins": { "hello-world": { "message": "Hello World" } }
}
```

- `sources[]` - where plugins are discovered. Every source is scanned for
  immediate subdirectories containing a `workbench.plugin.json` manifest.
  - `kind: "path"` - a local directory; `path` is relative to the config file.
  - `kind: "git"` - a git coordinate: `{ "kind": "git", "url": "...", "ref": "main", "subdir": "plugins" }`.
    The checkout is cached under `$WORKBENCH_CACHE_DIR/<id>` (default
    `<config dir>/.workbench/sources/<id>`, never committed) and scanned like a
    `path` source.
    - `ref` accepts a BRANCH, a TAG or a COMMIT SHA (default: the remote HEAD).
    - `subdir` selects the plugin subtree inside the checkout.
    - The FIRST use clones through a staging directory and `rename`s it into
      place, so a failed or interrupted clone never leaves a half-populated
      source that would be scanned. An update is an in-place `fetch` plus a
      forced detached `checkout` of the same `ref`.
    - A source that cannot be resolved (bad url, unresolvable ref, missing git,
      missing subdir) is an ERROR NAMING the source - `source 'id' (git <url> @
      <ref>)` plus git's own stderr - and the loader SKIPS it, so stale or
      partial code is never served silently.
    - `workbench plugins` (and `--json`) report the resolved checkout path of
      every source, so a fetched source is inspectable.
  - `id` - stable source id used in reports (defaults to the directory/repo name).
  - `external: false` - marks a core source; everything else counts as external
    (and is skipped by `--no-external`).
- `plugins{}` - per-plugin CONFIG, keyed by plugin name, passed to the plugin's
  `apply(ctx, config)`. It is NOT a list of enabled plugins: a discovered plugin
  with no entry here is still loaded (its `apply()` receives `{}`), and
  `plugins.<name>.disabled: true` is the explicit opt-out (the plugin is not
  imported and is reported under `disabled`, never under the load failures).
- String values may reference the environment (`${env:VAR}`); they are expanded
  when the config is read, and missing variables are a hard error. Secrets are
  referenced by name only - never inline them in this file.

### Credentials

Workbench serves credentials through a three-role capability seam: a **Service
Definition** (the contract, in the core), one or more **Service Providers**
(every one an external plugin - the core ships NONE), and **Consumers** (config
values, the CLI, plugins). The four basic backends `env`, `file`, `project-env`
and `user-env` come from the plugin `credentials-basic` in the public plugins
repository; a `${cred:...}` source or plugin is loaded only after a provider
plugin is loaded. Full description: [docs/CREDENTIALS.md](docs/CREDENTIALS.md).

Config values may reference a credential by NAME, resolved through the
credentials service:

```yaml
credentials:
  providers: [env, file]   # enabled providers, in precedence order

plugins:
  hello-world:
    message: "token is ${cred:DEPLOY_TOKEN}"
```

A reference may also carry a scope (`${cred:SCOPE/NAME}`); `credentials.scope`
is a fallback for unscoped references, looked up only after the unscoped form
missed. Adding an external provider (e.g. a Vault-backed one) needs no core
change: a manifest capability declaration plus a `sources:` row and a
`credentials.providers:` row - see
[docs/CREDENTIALS.md](docs/CREDENTIALS.md) section 5.

Providers are selected by configuration only: swapping one is a config edit.
Credential values are never logged, printed or persisted - the CLI masks them
and errors name the reference, never the value.

### YAML notes

- Parse and validation errors name the config file (YAML parse errors also carry
  the parser's line/column); a broken file is never silently replaced by another
  format.
- YAML types its scalars: unquoted `42` is a number and `true`/`false` are
  booleans (the parser follows the YAML 1.2 core schema, so `yes`/`on` stay
  strings). `${env:VAR}` expansion and the validation messages only treat
  strings as strings, so **quote values that must stay strings**, e.g.
  `message: "42"` or `message: "on"`.

## Layout

```
workbench/                       the KERNEL: no plugin, no feature module
  src/
    cli.ts        CLI entrypoint (npm run dev)
    credentials/  the credentials capability: the DEFINITION only (no provider)
    web-seam.ts       the TYPE-ONLY web@1 seam: the core registers its /health
                      and /api/plugins routes on it, the provider is a plugin
    kernel.ts     boot: cordis root context + workbench service + load + ${cred:} gate
    loader.ts     plugin discovery + manifest validation + import + ctx.plugin
    registry.ts   the workbench service (commands + plugins)
    sources.ts    source resolution (path + git cache; auth is a credential REF)
    source-auth.ts  a credential ref -> a TRANSIENT git auth argument
    web/ would be a REGRESSION: the whole web module (the web@1 Definition AND
          the http/shell servers) lives in nexuslbs/workbench-plugins
          (definitions/web.ts, plugins/web-impl) since v0.0.3; the core only
          keeps the `web:` config section and DEFERS it until a provider plugin
          is loaded
    config.ts     JSON/YAML config reading, default-file lookup, ${env:VAR} expansion
    types.ts      manifest / command / plugin / config types + the ctx.workbench type
  test/
    kernel.test.ts  load-and-run tests, incl. CLI end to end and `serve`
    fixtures.ts     temp external-plugin fixture (no sibling checkout needed)
  workbench.config.yml          default config: ZERO sources, ZERO plugins
  workbench.config.example.yml  the same, with the source shapes commented out
  docs/PLUGIN-CONTRACT.md
```

Every plugin - including the test ones the core's own tests use - lives in the
external `nexuslbs/workbench-plugins` repository (`plugins/`), never here.

## Plugins

Read [`docs/PLUGIN-CONTRACT.md`](docs/PLUGIN-CONTRACT.md). In short: one plugin =
one directory with a `workbench.plugin.json` manifest and an ESM entry module
whose default export is a cordis plugin; the plugin registers its capabilities
through the injected `ctx.workbench` service (and only through it).

**`sources:` DISCOVERS, `plugins:` LOADS (INTENTIONAL BREAKING CHANGE).** A
plugin directory inside a scanned source is DISCOVERED: it is part of the
"available plugins" inventory (`workbench plugins`, the Plugin Inventory page)
but it is LOADED only when the config NAMES it under `plugins:`. Naming it is
therefore how it is enabled, and the row is also its config - it is passed to
`apply(ctx, config)`, `{}` when the row has no fields, so `apply()` must not
require optional config. A discovered plugin with NO row is reported as
`available`: installable in one click (`enable` persists its row) and never
imported. `plugins.<name>.disabled: true` is the PARK: configured, deliberately
off, listed under `disabled` and never under `failures`. A config written for the
old scan-and-load semantics must now list every plugin it wants loaded.

```yaml
sources:                      # where plugins are DISCOVERED (available)
  - kind: path
    id: workbench-plugins
    path: ../workbench-plugins/plugins

plugins:                      # the ROSTER: what is LOADED, plus its config
  plugin-inventory: {}        # named -> loaded
  plugin-manager: {}          #       (an empty row is a valid config)
  credentials-stub:
    disabled: true            # parked: not imported, listed under `disabled`
# ANY other discovered plugin is `available` - listed, not loaded
```

A plugin that needs config reports a "not configured" state gracefully and fails
only when its capability is actually used: "not configured" is not an error and
never appears in the load failures, while an `apply()` throw always does.

Product plugins live in `nexuslbs/workbench-plugins`. The core repo only hosts
the core test plugin `hello-world`, and it is loaded through exactly the same
path as any external plugin.

## Tests

```bash
npm test        # node --test test/*.test.ts
npm run typecheck
```

`test/kernel.test.ts` boots the kernel with the default (core-only) config and
asserts nothing external is loaded, then with a temp FIXTURE source: the core
plugin and the external fixture plugin load through the same mechanism (the
external one with `source: workbench-plugins`), both commands produce their
greeting, and the CLI prints `Hello Otherworld`. It also covers
`includeExternal: false`, `CONFIG_FILE` selection (empty = default) and that
`serve` answers `/health` and stays up until `SIGTERM`. The fixture lives in
`test/fixtures.ts` and is created in a temp dir, so the suite needs no sibling
`workbench-plugins` checkout.
`test/config.test.ts` covers the loader itself: YAML/JSON parity (config and
kernel state), `${env:VAR}` expansion in a YAML config, the default-file
resolution order (yml > yaml > json) plus the repo default resolving to
`workbench.config.yml`, malformed YAML naming the file, unknown extensions and
non-string scalars in the validation messages.
`test/sources.test.ts` covers `git` sources against temp git fixtures: the
first-use clone (into a staging dir, moved into place) plus `subdir` scan and the
fetched plugin really answering, in-place update for branch/tag/sha refs, a
missing `subdir`, a bad url and an unresolvable ref (each naming the source and
leaving no half-populated checkout behind), a leftover non-checkout directory
being replaced, a missing git binary, and a `git` source without a url.

## License

MIT.

## Image & publishing (ghcr.io/nexuslbs/workbench)

The repo builds its own container image from the root `Dockerfile`
(`FROM node:22-bookworm-slim`, the core checkout, `npm ci --omit=dev`, `git` for
`git` plugin sources, `serve` on `WORKBENCH_PORT`/8080 with `/health`):

```sh
docker build -t workbench:dev .
docker run --rm -p 8080:8080 workbench:dev
curl -fsS http://127.0.0.1:8080/health
```

The image is the **core** only: no plugin repository is vendored into it and no
deployment config is baked into it. A deployment passes its own config at RUN
time via `CONFIG_FILE` (a mount), so plugins can be added/removed by editing the
config and reloading, without rebuilding the image.
### The browser is a SEPARATE image (the core image ships NO browser)

The published core image is browser-free by design: no chromium and no playwright
browser cache are baked into it. Driving a real browser is a DEPLOYMENT input,
exactly like a plugin source: run ONE browser service from its OWN image and
point the `browser-use-playwright` provider at it.

The browser service image itself is built and published from the PLUGINS
repository, `nexuslbs/workbench-plugins` (`browser/Dockerfile` +
`.github/workflows/browser-publish.yml`): pushing a tag `browser-X.Y.Z`
publishes `ghcr.io/nexuslbs/workbench-plugins/browser:X.Y.Z` (and `:latest`).
The core repository ships NO browser image and no longer builds one.

```sh
docker run -d --name workbench-browser \
  -p 127.0.0.1:9222:9222 \
  ghcr.io/nexuslbs/workbench-plugins/browser:0.0.1
```

```yaml
browser-use-playwright:
  browserService:
    endpoint: http://127.0.0.1:9222
    image: ghcr.io/nexuslbs/workbench-plugins/browser:0.0.1
    generalService: { type: container, params: { container: workbench-browser } }
    start: '<start chromium with --remote-debugging-port=9222>'
```

The browser image/service is reached through the `general-service@1` seam
(`workbench-plugins`), so the TRANSPORT is config (container / ssh / shell /
http) and the browser is never part of the workbench image. A bare `wsEndpoint`
(the `cdpEndpoint` alias) attaches the same way. With nothing configured - and
nothing answering - the provider answers the typed `browser-use.no-browser` /
`browser-use.endpoint-unreachable` error naming the missing prerequisite; it
never falls back to a local launch and never to an HTTP fetch pretending to be a
browser. See `workbench-plugins/docs/SERVICES.md`, section "Browser-use
capability".

`.github/workflows/publish.yml` publishes to GHCR:

| Event | Published tags |
| --- | --- |
| push to branch `stable` | `ghcr.io/nexuslbs/workbench:latest` (only `latest`) |
| push of tag `vX.Y.Z` | `ghcr.io/nexuslbs/workbench:X.Y.Z` and `:latest` |

The workflow builds the image once, validates that created image in a separate
job (with the deployment config supplied at run time,
`deploy/ci/deployment.config.yml`), and only then pushes the same image; auth is
the workflow's own `GITHUB_TOKEN` with `packages: write`. `.dockerignore` keeps
`deploy/`, `.github/` and `node_modules` out of the image. See
[`deploy/README.md`](deploy/README.md) for the full deployment/publishing notes.

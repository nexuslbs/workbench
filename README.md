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

The core repo is self-contained: its default config (`workbench.config.yml`)
declares the core plugins that ship with it and nothing else, so it boots with
no plugin repository present.

```bash
npm run dev -- plugins         # lists the loaded plugins and their sources
npm run dev -- hello world     # -> Hello World (core plugin)
npm run dev -- serve           # long-running service mode (see below)
```

Raw output of the documented smoke command:

```console
$ npm run dev -- plugins
workbench: 1 plugin(s) loaded (1 core, 0 external)
source core (path, core): /path/to/workbench/plugins [1 plugin(s)]
  hello-world@0.1.0  core  [command:hello world]

$ npm run dev -- hello world
Hello World
```

Load an EXTERNAL plugin repository by declaring it in your config (consumed as
an external source, never vendored into this repo) - a sibling checkout
(`kind: path`) or, in production, a git coordinate (`kind: git`):

```yaml
sources:
  - kind: path
    id: core
    path: ./plugins
    external: false
  - kind: git
    id: workbench-plugins
    url: https://github.com/nexuslbs/workbench-plugins
    ref: main
    subdir: plugins
```

```bash
npm run dev -- --config /path/to/that/config.yml plugins
CONFIG_FILE=/path/to/that/config.yml npm run dev -- plugins   # same thing
```

Plugin loading messages go to stderr, command output to stdout.

## Service mode (`serve`)

`workbench serve` boots the plugins, serves a tiny status endpoint
(`GET /health` -> the config file, the loaded plugins and their sources) and
stays up until `SIGINT`/`SIGTERM`. It is what the compose service runs, so the
container is `Up` because it hosts something, not because it sleeps.

```console
$ npm run dev -- serve
workbench: serving on http://0.0.0.0:12347 config=/path/to/workbench.config.yml
workbench: 1 plugin(s) loaded (1 core, 0 external)
source core (path, core): /path/to/workbench/plugins [1 plugin(s)]
  hello-world@0.1.0  core  [command:hello world]
```

Environment (all optional):

| Variable | Meaning |
| --- | --- |
| `CONFIG_FILE` | Config file to use when `--config` is not given; empty/unset = the default lookup described below. |
| `WORKBENCH_PORT` | Port of the `serve` status endpoint (default `12347`); `--port` wins. |
| `WORKBENCH_CACHE_DIR` | Where `git` plugin sources are checked out (default `<config dir>/.workbench/sources`). |

## CLI

| Command | Description |
| --- | --- |
| `workbench serve` | Boot the plugins and keep running (service mode; status endpoint on `--port` / `WORKBENCH_PORT`, default 12347). |
| `workbench <command> [args...]` | Run the command registered by a plugin (longest match wins, the rest becomes args). |
| `workbench plugins` | List loaded plugins, their source and their capabilities. |
| `workbench commands` | List the registered commands (and the plugin that registered them). |
| `workbench plugins --json` / `workbench commands --json` | Machine-readable variants. |
| `--config <file>` | Use another config file; `.json`, `.yml` or `.yaml` (the extension selects the parser). |
| `--port <n>` | `serve` only: status endpoint port (overrides `WORKBENCH_PORT`). |
| `--no-external` | Skip external sources (only the core plugins load). |
| `--help` | Usage. |

With npm: `npm run dev -- <args>`.

## Config (`workbench.config.yml` / `.yaml` / `.json`)

The same schema is read from **JSON or YAML** - the file extension selects the
parser (`.json` -> JSON, `.yml` / `.yaml` -> YAML; any other extension is an
error, the core never guesses). Without `--config` the core looks for, in order,
`workbench.config.yml`, `workbench.config.yaml`, `workbench.config.json` in the
working directory and then next to the core; the first existing file wins and a
missing config names all three candidates.

YAML, with comments - this is the shipped default: core-only, with the external
source as a commented EXAMPLE (the core never depends on a plugin repository):

```yaml
# workbench.config.yml
sources:
  # core plugins that ship with this repository
  - kind: path
    id: core
    path: ./plugins
    external: false
  # EXAMPLE - an external repository of plugins:
  # - kind: git
  #   id: workbench-plugins
  #   url: https://github.com/nexuslbs/workbench-plugins
  #   ref: main
  #   subdir: plugins

plugins:
  hello-world: { message: Hello World }
```

The same schema in JSON (JSON has no comments, so an external source is a real
entry there):

```json
{
  "sources": [{ "kind": "path", "id": "core", "path": "./plugins", "external": false }],
  "plugins": { "hello-world": { "message": "Hello World" } }
}
```

- `sources[]` - where plugins are discovered. Every source is scanned for
  immediate subdirectories containing a `workbench.plugin.json` manifest.
  - `kind: "path"` - a local directory; `path` is relative to the config file.
  - `kind: "git"` - a git coordinate: `{ "kind": "git", "url": "...", "ref": "main", "subdir": "plugins" }`.
    The checkout is cached under `.workbench/sources/<id>` (never committed).
  - `id` - stable source id used in reports (defaults to the directory/repo name).
  - `external: false` - marks a core source; everything else counts as external
    (and is skipped by `--no-external`).
- `plugins{}` - per-plugin config, keyed by plugin name, passed to the plugin's
  `apply(ctx, config)`.
- String values may reference the environment (`${env:VAR}`); they are expanded
  when the config is read, and missing variables are a hard error. Secrets are
  referenced by name only - never inline them in this file.

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
workbench/
  src/
    cli.ts        CLI entrypoint (npm run dev)
    kernel.ts     boot: cordis root context + workbench service + load
    loader.ts     plugin discovery + manifest validation + import + ctx.plugin
    registry.ts   the workbench service (commands + plugins)
    sources.ts    source resolution (path + git cache)
    config.ts     JSON/YAML config reading, default-file lookup, ${env:VAR} expansion
    types.ts      manifest / command / plugin / config types + the ctx.workbench type
  plugins/
    hello-world/  core test plugin (loaded through the plugin-source mechanism)
  test/
    kernel.test.ts  load-and-run tests, incl. CLI end to end and `serve`
    fixtures.ts     temp external-plugin fixture (no sibling checkout needed)
  workbench.config.yml          default config (core-only YAML, external EXAMPLE commented out)
  workbench.config.example.yml  the same core-only config (for `--config`)
  docs/PLUGIN-CONTRACT.md
```

## Plugins

Read [`docs/PLUGIN-CONTRACT.md`](docs/PLUGIN-CONTRACT.md). In short: one plugin =
one directory with a `workbench.plugin.json` manifest and an ESM entry module
whose default export is a cordis plugin; the plugin registers its capabilities
through the injected `ctx.workbench` service (and only through it).

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

## License

MIT.

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
git clone https://github.com/nexuslbs/workbench-plugins.git   # sibling dir: the default external source
cd workbench
npm install
npm test
```

Boot the host and see both the core plugin and the external plugin:

```bash
npm run dev -- plugins         # lists the loaded plugins and their sources
npm run dev -- hello world     # -> Hello World          (core plugin)
npm run dev -- hello otherworld # -> Hello Otherworld    (external plugin)
```

Raw output of the documented smoke command:

```console
$ npm run dev -- plugins
[workbench] loaded plugin hello-world@0.1.0 from core (core)
[workbench] loaded plugin hello-otherworld@0.1.0 from workbench-plugins (external)
workbench: 2 plugin(s) loaded (1 core, 1 external)
source core (path, core): /path/to/workbench/plugins [1 plugin(s)]
source workbench-plugins (path, external): /path/to/workbench-plugins/plugins [1 plugin(s)]
  hello-world@0.1.0  core  [command:hello world]
  hello-otherworld@0.1.0  external:workbench-plugins  [command:hello otherworld]

$ npm run dev -- hello world
[workbench] loaded plugin hello-world@0.1.0 from core (core)
[workbench] loaded plugin hello-otherworld@0.1.0 from workbench-plugins (external)
Hello World

$ npm run dev -- hello otherworld
[workbench] loaded plugin hello-world@0.1.0 from core (core)
[workbench] loaded plugin hello-otherworld@0.1.0 from workbench-plugins (external)
Hello Otherworld
```

Plugin loading messages go to stderr, command output to stdout.

## CLI

| Command | Description |
| --- | --- |
| `workbench <command> [args...]` | Run the command registered by a plugin (longest match wins, the rest becomes args). |
| `workbench plugins` | List loaded plugins, their source and their capabilities. |
| `workbench commands` | List the registered commands (and the plugin that registered them). |
| `workbench plugins --json` / `workbench commands --json` | Machine-readable variants. |
| `--config <file>` | Use another config file. |
| `--no-external` | Skip external sources (only the core plugins load). |
| `--help` | Usage. |

With npm: `npm run dev -- <args>`.

## Config (`workbench.config.json`)

```json
{
  "sources": [
    { "kind": "path", "id": "core", "path": "./plugins", "external": false },
    { "kind": "path", "id": "workbench-plugins", "path": "../workbench-plugins/plugins" }
  ],
  "plugins": {
    "hello-world": { "message": "Hello World" },
    "hello-otherworld": { "message": "Hello Otherworld" }
  }
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

## Layout

```
workbench/
  src/
    cli.ts        CLI entrypoint (npm run dev)
    kernel.ts     boot: cordis root context + workbench service + load
    loader.ts     plugin discovery + manifest validation + import + ctx.plugin
    registry.ts   the workbench service (commands + plugins)
    sources.ts    source resolution (path + git cache)
    config.ts     config file reading and ${env:VAR} expansion
    types.ts      manifest / command / plugin / config types + the ctx.workbench type
  plugins/
    hello-world/  core test plugin (loaded through the plugin-source mechanism)
  test/
    kernel.test.ts  load-and-run tests, incl. CLI end to end
  workbench.config.json
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

`test/kernel.test.ts` boots the kernel with the real config, asserts that both
plugins are loaded (the external one with `source: workbench-plugins`), that both
commands produce their greeting, and that the CLI prints `Hello Otherworld`. A
second test boots with `includeExternal: false` and asserts the external plugin
disappears - so the suite fails when the external plugin is not loaded.

## License

MIT.

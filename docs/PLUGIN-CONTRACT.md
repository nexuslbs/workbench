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
the immediate subdirectories of every configured source and loads each one that
contains a `workbench.plugin.json`.

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

Secrets are referenced by name only. A plugin never receives secret values
inline; the operator config references them (`${env:VAR}` expansion is available
in config values) and the core decides how to hand them over.

## 5. How an external source is added

The core config (JSON `workbench.config.json` or YAML `workbench.config.yml` /
`workbench.config.yaml`; the extension selects the parser) lists sources:

```json
{
  "sources": [
    { "kind": "path", "id": "core", "path": "./plugins", "external": false },
    { "kind": "path", "id": "workbench-plugins", "path": "../workbench-plugins/plugins" },
    { "kind": "git", "id": "workbench-plugins-git", "url": "https://github.com/nexuslbs/workbench-plugins.git", "ref": "main", "subdir": "plugins" }
  ],
  "plugins": { "hello-otherworld": { "message": "Hello Otherworld" } }
}
```

- `path` sources are local directories (`path` relative to the config file).
- `git` sources are cloned/fetched into `.workbench/sources/<id>` (git required)
  and then scanned like a path source (`subdir` selects the plugin directory).
- `external: false` marks a core source; every other source is external and is
  skipped by `--no-external`.
- Without `--config` the core looks for `workbench.config.yml`, then
  `workbench.config.yaml`, then `workbench.config.json` in the working directory
  (and then next to the core) and uses the first one that exists. Both formats
  share the schema, the validation and the `${env:VAR}` expansion; YAML scalars
  are typed, so quote values that must stay strings.

There is no per-plugin registration code: dropping a plugin directory into a
configured source is the whole wiring. The loader is directory-driven, so a new
plugin in `workbench-plugins` is picked up by the existing source without any
core change (no config entry needed beyond the source itself).

## 6. What must not be in the core

The core is a host: cordis boot, source resolution, manifest discovery/loading,
the command registry and the CLI. Anything that does actual work (deployments,
publishing, providers, ...) belongs to a plugin. If a feature cannot be expressed
as a plugin, the plugin contract - not the core - is what has to change.

# Deploying the workbench image

This directory holds the **packaging / deployment** material of the core repo -
nothing here is a product feature, and nothing here is baked into the image.

## The image

`Dockerfile` (repo root) builds the core image:

```sh
docker build -t workbench:dev .          # FROM node:22-bookworm-slim + this repo
docker run --rm -p 12347:12347 workbench:dev
curl -fsS http://127.0.0.1:12347/health   # -> {"status":"ok",...}
```

- `FROM` the **official** Node.js image (`node:22-bookworm-slim`; 22.x satisfies
  `engines.node >= 22.18`), `COPY . .`, `npm ci --omit=dev` (the core strips
  TypeScript at run time, so there is no build step and no toolchain).
- `git` + `ca-certificates` are installed so plugin sources of kind `git` can be
  cloned; `WORKBENCH_CACHE_DIR=/var/cache/workbench` is a writable checkout dir.
- The default command is `node src/cli.ts serve`: it boots the configured
  plugins, serves `/health` (and, when the config rosters the web PROVIDER PLUGIN from the
  external source, the Web UI too) on `WORKBENCH_PORT` (default `12347`), and
  stays up. The web server itself is a PLUGIN (`web-impl`): with
  `web.enabled: true` and no provider plugin the core reports `web: deferred`
  and answers `/health` on the port itself.
- **Minimal by design**: the image is a *core* checkout. No plugin repository is
  vendored into it, no deployment config is baked in, no secret is baked in.

## The deployment config is a RUN-TIME input

A deployment declares its plugin sources and its per-plugin config in **its own
config file**, supplied when the image is RUN - never during the build:

```sh
docker run --rm -p 12347:12347 \
  -e CONFIG_FILE=/etc/workbench/deployment.config.yml \
  -v "$PWD/my-deploy:/etc/workbench:ro" \
  ghcr.io/nexuslbs/workbench:latest
```

`CONFIG_FILE` (or `--config`) selects the file; without it the core falls back to
the config shipped in the image (`workbench.config.yml`). Because the config is a
run-time input, the image is created ONCE and never changes:

- add or remove a plugin by editing that file and reloading
  (`POST /api/settings/patch` persists + re-reads; the plugin-manager seam
  `POST /api/plugin-manager/action` installs/unloads/enables/disables plugins) -
  **no rebuild**;
- or let the edit be applied on its own: when the `config-watch` PLUGIN from
  `nexuslbs/workbench-plugins` is on the `plugins:` roster, the running process
  WATCHES the config file and applies an external edit live (debounced, with
  atomic-write handling, self-write suppression and its state at
  `GET /api/config-watch/state`): it triggers the core's `host.reconcile()`, so
  no restart and no HTTP lifecycle call are needed. Without that row the core
  opens NO watch handle - the core itself never watches the file;
- `.dockerignore` excludes `deploy/`, and no build stage `COPY`s a deployment
  config, so the config can never leak into a layer;
- credentials in it are references **by name** only (`${cred:NAME}`, `${env:VAR}`),
  never a value.

`deploy/ci/deployment.config.yml` is the config the CI validation uses: NO core
plugin source (the image is a core checkout and the core ships ZERO plugins)
plus the **external** `nexuslbs/workbench-plugins` repository as a `git` source,
and the `web-impl` provider plugin rostered so the live add/remove checks can drive the
plugin-manager seam.

## Publishing (GitHub Actions, `.github/workflows/publish.yml`)

| Event | Published tags |
| --- | --- |
| push to branch `stable` | `ghcr.io/nexuslbs/workbench:latest` (**only** `latest`) |
| push of tag `vX.Y.Z` (e.g. `v0.0.1`) | `ghcr.io/nexuslbs/workbench:X.Y.Z` **and** `:latest` |

The image name equals the repository path, so the artifact is exactly
`ghcr.io/nexuslbs/workbench:<tag>`.

Jobs, in order:

1. **Build image** - `npm ci` + `npm run typecheck` + `npm test` on the runner,
   then `docker build` (never pushed) and `docker save | gzip` into an artifact.
   The publish tags are computed here from the event (`docker/metadata-action`):
   `latest` for `stable`, `X.Y.Z` + `latest` for a `v*` tag. No other tag is
   ever produced.
2. **Validate created image (run-time config)** - a SEPARATE job that loads that
   very artifact, checks the deployment config is **not** inside the image (and
   that the image ships no `plugins/` tree), then
   starts an ephemeral container with `CONFIG_FILE` + the config mounted,
   waits for `/health`, runs the CLI, loads an external plugin from the
   `workbench-plugins` clone, and finally changes the plugin set live (install a
   source, disable a plugin) and asserts the image id is **identical** before and
   after. Nothing is committed back: no `docker commit`, no rebuild.
3. **Publish image to GHCR** - loads the SAME artifact (the image the tests
   validated), logs in with the workflow `GITHUB_TOKEN` (`packages: write`) and
   pushes exactly the tags the policy prescribes.

Authentication is the workflow's own `GITHUB_TOKEN`: no PAT, no app key and no
token is referenced by, stored in, or committed to this repository.

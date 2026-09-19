# syntax=docker/dockerfile:1
#
# workbench core image - ghcr.io/nexuslbs/workbench
#
# The build context IS this repository: the image carries the workbench CORE
# (loader / registry / plugin contract) and NOTHING else. Plugins are never
# vendored here: a deployment declares its plugin sources in ITS OWN config
# file, which is a RUN-time input (`CONFIG_FILE`, see `deploy/README.md`), not
# an image layer. The image never changes after it is built.
#
# Build (no build args, no credential, no network beyond the base image and npm):
#   docker build -t ghcr.io/nexuslbs/workbench:dev .
#
# Run (deployment config mounted read-only, port published):
#   docker run --rm -p 12347:12347 \
#     -e CONFIG_FILE=/etc/workbench/workbench.config.yml \
#     -v "$PWD/my-deployment.config.yml:/etc/workbench/workbench.config.yml:ro" \
#     ghcr.io/nexuslbs/workbench:dev
#   curl -fsS http://127.0.0.1:12347/health

# Official Node.js image. 22.x satisfies `engines.node >= 22.18` from
# package.json; the core strips TypeScript at run time (no build step) and the
# runtime dependencies are the only ones installed, so no dev dependency and no
# toolchain is needed.
FROM node:22-bookworm-slim

# Client tools the plugins need for their external transports (behind the
# scenes) - BUILD-time only, a container start installs nothing and the image
# stays runnable offline:
#   git             - plugin sources of kind `git` (cloned at boot) and HTTPS
#   ca-certificates - HTTPS fetches
#   curl            - the HEALTHCHECK below
#   openssh-client  - the `ssh` / `ssh+container` transports
#   docker-ce-cli + - the `container` transport: `docker compose -p <project>
#   docker-compose-   --env-file <env> -f <file> exec -T <service> sh -c '<args>'
#   plugin            into a sibling service of a deployment stack (himalaya
#                     lives only in the omni `toolbox` image). CLIENT ONLY: no
#                     daemon, no docker-in-docker, no privileged mode - the
#                     deployment mounts the host socket (docker.sock) so this
#                     client reaches the HOST daemon.
#
# Versions: the Docker apt repo CHANNEL is pinned ("stable" for this image's own
# Debian codename, bookworm on node:22-bookworm-slim), not an exact apt version:
# the repo prunes old builds, so an exact pin turns a rebuild into a failure.
# The resolved versions are printed below at build time and recorded in the
# deploy README. Alternative route (not used): the published STATIC client
# binaries (download.docker.com/linux/static/stable) - no apt repo and no key,
# but the compose v2 plugin comes from its own GitHub release and must be kept
# in sync by hand.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends git ca-certificates curl openssh-client; \
    install -m 0755 -d /etc/apt/keyrings; \
    curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
    chmod a+r /etc/apt/keyrings/docker.asc; \
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin; \
    docker --version; \
    docker compose version; \
    ssh -V; \
    rm -rf /var/lib/apt/lists/*

WORKDIR /workbench

# Dependencies first so a source-only change reuses the dependency layer.
# Installed HERE: a container start installs nothing and runs offline.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund \
 && npm cache clean --force

# The core. `.dockerignore` keeps node_modules, .git, .github and deploy/ out of
# the image - a deployment config must never be baked in.
COPY . .

# Where git plugin sources are checked out (writable). Deliberately OUTSIDE
# /opt: the workbench compose service bind-mounts the host /opt at /opt, so a
# checkout under /opt in the image would be shadowed at run time.
RUN mkdir -p /var/cache/workbench
ENV WORKBENCH_CACHE_DIR=/var/cache/workbench

# Status endpoint of `serve` (`/health`). CONFIG_FILE is read at START:
# unset/empty = the config shipped inside the image, non-empty = that file
# (typically a mount) - the deployment config seam.
ENV WORKBENCH_PORT=12347
EXPOSE 12347

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${WORKBENCH_PORT}/health" || exit 1

# Long-running entrypoint: boot the configured plugins and STAY UP (a container
# that only sleeps would report Up while hosting nothing).
CMD ["node", "src/cli.ts", "serve"]

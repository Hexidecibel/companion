# syntax=docker/dockerfile:1.7
#
# Companion daemon + web UI. Claude Code is NOT in the image: install it into
# the persistent volume with `docker compose run --rm companion setup-claude`.
# See docs/docker.md.
ARG NODE_VERSION=20

# ---------------------------------------------------------------- build
# JavaScript only (no native modules), so it builds once on the build host's
# platform and the result is copied into every target architecture.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-bookworm-slim AS build
ENV CI=1 COMPANION_SKIP_POSTINSTALL=1 NODE_ENV=development
WORKDIR /src

COPY web/package.json web/package-lock.json web/
RUN --mount=type=cache,target=/root/.npm cd web && npm ci --no-audit --no-fund
COPY daemon/package.json daemon/package-lock.json daemon/
# --ignore-scripts: the postinstall writes a host config (not wanted in an image)
RUN --mount=type=cache,target=/root/.npm cd daemon && npm ci --ignore-scripts --no-audit --no-fund

COPY web/ web/
# The daemon-served bundle (/web/ base). Never build:desktop here.
RUN cd web && npm run build

COPY daemon/ daemon/
# The app version (1.0.<git commit count>): the build context has no .git, so
# bin/docker and CI pass it in; `npm run build` writes it to dist/version.json,
# the one version source for /health, mDNS and the CLI (daemon/src/version.ts).
ARG COMPANION_VERSION=dev
RUN cd daemon && COMPANION_VERSION="$COMPANION_VERSION" npm run build \
 && npm prune --omit=dev --no-audit --no-fund \
 && rm -rf src __tests__ coverage

# ---------------------------------------------------------------- runtime
FROM node:${NODE_VERSION}-bookworm-slim

ARG COMPANION_VERSION=dev
LABEL org.opencontainers.image.title="Companion" \
      org.opencontainers.image.description="Companion daemon and web UI: your Claude Code sessions on every device" \
      org.opencontainers.image.source="https://github.com/hexidecibel/companion" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.version="${COMPANION_VERSION}"

# tmux runs the Claude Code sessions; git for review/worktrees; procps/psmisc
# for pgrep/pstree (session process lookups); tini reaps tmux's children.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tmux git openssh-client ca-certificates curl procps psmisc tini less \
 && rm -rf /var/lib/apt/lists/*

# The base image's "node" user (uid/gid 1000) becomes "companion". The
# entrypoint remaps it to PUID/PGID at start, so files on bind mounts get the
# host user's ownership.
RUN usermod -l companion -d /home/companion -m node \
 && groupmod -n companion node \
 && mkdir -p /home/companion/.claude /home/companion/.companion /home/companion/.local/bin /home/companion/projects \
 && chown -R companion:companion /home/companion \
 && chmod 700 /home/companion/.claude /home/companion/.companion

COPY --from=build /src/daemon/dist /app/daemon/dist
COPY --from=build /src/daemon/node_modules /app/daemon/node_modules
COPY --from=build /src/daemon/package.json /app/daemon/package.json
COPY --from=build /src/web/dist /app/web/dist
COPY docker/ /app/docker/
COPY docker/tmux.conf /etc/tmux.conf
RUN chmod 755 /app/docker/*.sh /app/docker/as-companion /app/docker/rootbin/* \
 && printf '#!/bin/sh\nexec node /app/daemon/dist/index.js "$@"\n' > /usr/local/bin/companion \
 && chmod 755 /usr/local/bin/companion

# rootbin wrappers (claude, tmux, companion) hand `docker compose exec` (root)
# over to the companion user; the daemon itself never has rootbin on PATH.
ENV PATH=/app/docker/rootbin:/home/companion/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
    LANG=C.UTF-8 \
    COMPANION_CONTAINER=docker \
    COMPANION_WEB_DIR=/app/web/dist \
    COMPANION_PROJECTS_DIR=/home/companion/projects \
    COMPANION_SETUP_CLAUDE=/app/docker/setup-claude.sh \
    CLAUDE_CONFIG_DIR=/home/companion/.claude \
    COMPANION_SKIP_POSTINSTALL=1 \
    NODE_ENV=production

WORKDIR /home/companion
EXPOSE 9877
VOLUME ["/home/companion/.claude", "/home/companion/.companion", "/home/companion/.local"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "/app/docker/healthcheck.js"]

ENTRYPOINT ["/usr/bin/tini", "--", "/app/docker/entrypoint.sh"]
CMD ["daemon"]

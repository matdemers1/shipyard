# syntax=docker/dockerfile:1.7
#
# Build context is the repo root. shipyard-agent: touches Docker, faces nothing — no listening
# port, ever (SHP-ADR-002). It runs as root because the Docker socket mount is root-equivalent
# regardless of the container user; the agent only ever runs manifest-defined argv steps against
# it (SHP-ADR-003), never an arbitrary command from a request.

FROM node:22-trixie-slim AS build

RUN npm install -g pnpm@10.34.5

WORKDIR /repo

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .

RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter shipyard-agent... --filter shipyard-cli...

RUN pnpm --filter @shipyard/schema build
RUN pnpm --filter @shipyard/sequence build
RUN pnpm --filter shipyard-agent build
# The host CLI (SHP-T-1.12) rides along in the agent image too, so a session already on the box
# can run `shipyard-run` without a separate install — it drives the same `@shipyard/sequence` the
# agent does, never its own deploy logic.
RUN pnpm --filter shipyard-cli build

# `minimum-release-age`/`trustPolicy` gate *resolving* new versions; this step only reproduces an
# already-vetted lockfile onto disk, so the policy is switched off here and only here.
RUN pnpm --filter shipyard-agent deploy --prod \
    --config.minimum-release-age=0 \
    --config.inject-workspace-packages=true \
    /out
RUN pnpm --filter shipyard-cli deploy --prod \
    --config.minimum-release-age=0 \
    --config.inject-workspace-packages=true \
    /cli-out

FROM node:22-trixie-slim AS runtime

ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=https://github.com/matdemers1/shipyard \
      org.opencontainers.image.licenses=Apache-2.0

ENV SHIPYARD_VERSION=$REVISION \
    NODE_ENV=production

# Pinned Docker CLI and Compose v5 plugin, copied from the official images rather than an apt
# repo, so the agent talks to the host's Docker Engine through a version it was tested against.
COPY --from=docker:29-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker/compose-bin:v5.5.1 /docker-compose /usr/libexec/docker/cli-plugins/docker-compose
RUN chmod +x /usr/libexec/docker/cli-plugins/docker-compose

WORKDIR /app
COPY --from=build /out ./

# The host CLI, deployed alongside the agent (SHP-T-1.12, SHP-REQ-032) — its own directory, not on
# the agent's own module path, with a thin launcher so it reads as the image's own bin, not a
# second request surface.
COPY --from=build /cli-out /cli
RUN printf '#!/bin/sh\nexec node /cli/dist/index.js "$@"\n' > /usr/local/bin/shipyard-run \
    && chmod +x /usr/local/bin/shipyard-run

# No EXPOSE — the agent opens no port. No `USER node` — it runs as root for socket access, in
# this phase (SHP-ADR-003); the socket mount itself is what grants root-equivalent access, not
# this line.
CMD ["node", "dist/index.js"]

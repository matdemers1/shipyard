# syntax=docker/dockerfile:1.7
#
# Build context is the repo root (workspace install needs the lockfile and every workspace
# member). shipyard-server: internet-facing, never touches Docker (SHP-ADR-002).

FROM node:22-trixie-slim AS build

RUN npm install -g pnpm@10.34.5

WORKDIR /repo

# Resolve from the lockfile first so this layer only re-runs when the lockfile itself changes.
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm fetch --frozen-lockfile

COPY . .

# `--offline` proves the fetch above was complete; nothing new is resolved from the network here.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter shipyard-server... --filter shipyard-web...

RUN pnpm --filter @shipyard/schema build
RUN pnpm --filter @shipyard/sequence build
RUN pnpm --filter shipyard-server build
# The console, served by the server from /app/public (one origin, one cookie).
RUN pnpm --filter shipyard-web build

# `minimum-release-age`/`trustPolicy` gate *resolving* new versions; this step only reproduces an
# already-vetted lockfile onto disk, so the policy is switched off here and only here.
RUN pnpm --filter shipyard-server deploy --prod \
    --config.minimum-release-age=0 \
    --config.inject-workspace-packages=true \
    /out

# `prisma generate` needs the prisma CLI (a prod dependency) but no database; run it inside /out
# so the generated client (`src/generated/prisma`) ships in the deployed package.
RUN cd /out && pnpm exec prisma generate

FROM node:22-trixie-slim AS runtime

# PostgreSQL 16 client tools, pinned: a newer pg_dump writes dumps 16 cannot restore.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl gnupg postgresql-common \
    && /usr/share/postgresql-common/pgdg/apt.postgresql.org.sh -y \
    && apt-get update && apt-get install -y --no-install-recommends postgresql-client-16 \
    && rm -rf /var/lib/apt/lists/* \
    && [ "$(pg_dump --version | grep -o '[0-9]\+' | head -1)" = "16" ]

ARG REVISION=unknown
LABEL org.opencontainers.image.revision=$REVISION \
      org.opencontainers.image.source=https://github.com/matdemers1/shipyard \
      org.opencontainers.image.licenses=Apache-2.0

ENV SHIPYARD_VERSION=$REVISION \
    NODE_ENV=production \
    PORT=3300 \
    CONSOLE_DIST=/app/public

WORKDIR /app
COPY --from=build --chown=root:root /out ./
COPY --from=build --chown=root:root /repo/apps/web/dist ./public

USER node

EXPOSE 3300
HEALTHCHECK CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/index.js"]

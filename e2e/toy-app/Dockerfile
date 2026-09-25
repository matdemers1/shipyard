# The toy app. Every behaviour is chosen at build time and baked into the image, so an image
# digest fully determines what a deploy will see.
ARG TOY_CONTRACT=0

FROM node:22-alpine AS base
ARG TOY_MODE=pass
ARG TOY_SCHEMA=0
ARG TOY_REVISION=0000000000000000000000000000000000000000
ENV NODE_ENV=production \
    PORT=3000 \
    TOY_MODE=${TOY_MODE} \
    TOY_SCHEMA=${TOY_SCHEMA} \
    TOY_REVISION=${TOY_REVISION}
LABEL org.opencontainers.image.revision=${TOY_REVISION} \
      org.opencontainers.image.title=shipyard-toy \
      dev.d3cloud.shipyard.schema=${TOY_SCHEMA}
WORKDIR /app
COPY server.mjs migrate.mjs backup.mjs restore.mjs ./
USER node
EXPOSE 3000
CMD ["node", "server.mjs"]

# TOY_CONTRACT=1 marks the release as a contract migration (never auto-rolled back).
FROM base AS contract-0
FROM base AS contract-1
LABEL dev.d3cloud.shipyard.migration=contract

FROM contract-${TOY_CONTRACT}

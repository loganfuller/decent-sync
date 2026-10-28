# The Decent Sync server image: the server plus the built management interface.
# It needs only PostgreSQL 14 or newer, reached through DATABASE_URL, and applies
# pending migrations on startup. docker-compose.yml runs it with PostgreSQL;
# the README covers configuration.

ARG NODE_VERSION=26

# npm needs every workspace's package.json to install from the lockfile.
FROM scratch AS manifests
COPY package.json package-lock.json /app/
COPY protocol/package.json /app/protocol/
COPY plugin/package.json /app/plugin/
COPY decent-sync.reaplugin/package.json /app/decent-sync.reaplugin/
COPY server/package.json /app/server/
COPY web/package.json /app/web/

FROM node:${NODE_VERSION}-bookworm-slim AS base
# Prisma's schema engine, which applies migrations, links against OpenSSL.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app

FROM base AS build
COPY --from=manifests /app/ ./
RUN npm ci
COPY tsconfig.base.json ./
COPY protocol/ protocol/
COPY server/ server/
COPY web/ web/
RUN npm run build -w protocol && npm run build -w web && npm run build -w server

# Only the server's production dependencies, with Prisma's engines for the
# target platform.
FROM base AS deps
COPY --from=manifests /app/ ./
RUN npm ci --omit=dev -w server && npm cache clean --force

FROM base
ENV NODE_ENV=production
COPY --from=deps /app/node_modules node_modules/
COPY --from=deps /app/package.json ./
COPY --from=build /app/protocol/package.json protocol/
COPY --from=build /app/protocol/dist protocol/dist/
COPY --from=build /app/server/package.json /app/server/prisma.config.ts server/
COPY --from=build /app/server/prisma server/prisma/
COPY --from=build /app/server/dist server/dist/
COPY --from=build /app/web/dist web/dist/

USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server/dist/main.js"]

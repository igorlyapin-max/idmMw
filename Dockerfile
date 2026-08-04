FROM node:22-bookworm AS backend-build

WORKDIR /app

ARG PRISMA_SCHEMA=prisma/schema.prisma
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY package.json package-lock.json ./
RUN npm ci --cache .npm --prefer-offline

COPY prisma ./prisma
RUN case "${PRISMA_SCHEMA}" in \
    *sqlite*) DATABASE_URL="file:/tmp/idmmw-build.db" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
    *cockroach*) DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=disable" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
    *) DATABASE_URL="postgresql://idmmw:idmmw@localhost:5432/idmmw" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
  esac

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-bookworm AS admin-ui-build

WORKDIR /app/ui
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY VERSION /app/VERSION
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --cache .npm --prefer-offline
COPY ui ./
RUN npm run build

FROM node:22-bookworm AS idm-emulator-build

WORKDIR /app/idm-emulator
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY idm-emulator/package.json idm-emulator/package-lock.json ./
RUN npm ci --cache .npm --prefer-offline
COPY idm-emulator ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime

ARG APP_VERSION=0.0.0.0
ARG GIT_REVISION=unknown
ARG SOURCE_CLEAN=false
ARG BUILD_PROVENANCE=unverified-local
ARG RUNTIME_ARTIFACT_SHA256=unknown
ARG IMAGE_CREATED=unknown

LABEL org.opencontainers.image.title="idmMw" \
  org.opencontainers.image.description="Avanpost IDM middleware" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${GIT_REVISION}" \
  org.opencontainers.image.created="${IMAGE_CREATED}" \
  ru.gkm.source.clean="${SOURCE_CLEAN}" \
  ru.gkm.build.provenance="${BUILD_PROVENANCE}" \
  ru.gkm.runtime-artifact.sha256="${RUNTIME_ARTIFACT_SHA256}"

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3010
ENV APP_VERSION=${APP_VERSION}
ENV GIT_REVISION=${GIT_REVISION}
ENV SOURCE_CLEAN=${SOURCE_CLEAN}
ENV BUILD_PROVENANCE=${BUILD_PROVENANCE}
ENV RUNTIME_ARTIFACT_SHA256=${RUNTIME_ARTIFACT_SHA256}
ENV IMAGE_CREATED=${IMAGE_CREATED}

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=backend-build /app/package.json /app/package-lock.json ./
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=backend-build /app/prisma ./prisma
COPY --from=admin-ui-build /app/ui/dist ./ui/dist
COPY --from=idm-emulator-build /app/idm-emulator/dist ./idm-emulator/dist
COPY VERSION ./VERSION

RUN set -eu; \
  mkdir -p /app/build /app/data /app/logs; \
  if [ "$APP_VERSION" != "0.0.0.0" ] && [ "$(cat /app/VERSION)" != "$APP_VERSION" ]; then \
    echo "APP_VERSION does not match /app/VERSION" >&2; \
    exit 1; \
  fi; \
  actual_artifact_sha256="$(cd /app/ui/dist && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
  printf '%s\n' "$actual_artifact_sha256" > /app/build/runtime-artifact.sha256; \
  if [ "$RUNTIME_ARTIFACT_SHA256" != "unknown" ] && [ "$actual_artifact_sha256" != "$RUNTIME_ARTIFACT_SHA256" ]; then \
    echo "RUNTIME_ARTIFACT_SHA256 does not match /app/ui/dist" >&2; \
    exit 1; \
  fi; \
  chown -R node:node /app

USER node

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const http=require('http');const https=require('https');const tls=process.env.HTTP_TLS_ENABLED==='true';const req=(tls?https:http).request({host:'127.0.0.1',port:process.env.PORT||3010,path:'/health',rejectUnauthorized:false},(res)=>process.exit(res.statusCode>=200&&res.statusCode<400?0:1));req.on('error',()=>process.exit(1));req.end();"

CMD ["node", "dist/main.js"]

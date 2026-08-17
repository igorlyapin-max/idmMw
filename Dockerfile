FROM node:22-bookworm AS node-build-base
COPY certs/customer-ca /usr/local/share/idmmw/customer-ca
ARG CUSTOMER_CA_REQUIRED=false
RUN set -eu; \
  ca_dir=/usr/local/share/idmmw/customer-ca; \
  ca_bundle=/usr/local/share/ca-certificates/idmmw/customer-ca.crt; \
  system_bundle=/etc/ssl/certs/ca-certificates.crt; \
  ca_files=/tmp/idmmw-customer-ca-files; \
  find "$ca_dir" -type f \( -name '*.crt' -o -name '*.pem' \) -print | sort > "$ca_files"; \
  if [ -s "$ca_files" ]; then \
    mkdir -p "$(dirname "$ca_bundle")" /etc/ssl/certs; \
    while IFS= read -r cert_file; do cat "$cert_file"; printf '\n'; done < "$ca_files" > "$ca_bundle"; \
    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; fi; \
    if [ -f "$system_bundle" ]; then cat "$ca_bundle" >> "$system_bundle"; else cp "$ca_bundle" "$system_bundle"; fi; \
    if command -v npm >/dev/null 2>&1; then npm config set cafile "$system_bundle" --global; fi; \
	  elif [ "$CUSTOMER_CA_REQUIRED" = "true" ]; then \
	    echo "CUSTOMER_CA_REQUIRED=true but no certs/customer-ca/*.crt or *.pem was provided" >&2; \
	    exit 1; \
	  fi; \
	  mkdir -p "$(dirname "$ca_bundle")"; \
	  touch "$ca_bundle"; \
	  rm -f "$ca_files"
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/idmmw/customer-ca.crt

FROM node-build-base AS backend-build

WORKDIR /app

ARG PRISMA_SCHEMA=prisma/schema.prisma
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY package.json package-lock.json ./
RUN npm ci --cache .npm --prefer-offline

COPY prisma ./prisma
RUN case "${PRISMA_SCHEMA}" in \
    *sqlite*) DATABASE_URL="file:/tmp/idmmw-build.db" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
    *cockroach*) DATABASE_URL="postgresql://root@localhost:26257/defaultdb?sslmode=require" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
    *) DATABASE_URL="postgresql://idmmw:REPLACE_WITH_LOCAL_DB_CREDENTIAL@localhost:5432/idmmw" npx prisma generate --schema="${PRISMA_SCHEMA}" ;; \
  esac

COPY nest-cli.json tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM node-build-base AS admin-ui-build

WORKDIR /app/ui
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY VERSION /app/VERSION
COPY ui/package.json ui/package-lock.json ./
RUN npm ci --cache .npm --prefer-offline
COPY ui ./
RUN npm run build

FROM node-build-base AS idm-emulator-build

WORKDIR /app/idm-emulator
ENV NPM_CONFIG_AUDIT=false
ENV NPM_CONFIG_FUND=false

COPY idm-emulator/package.json idm-emulator/package-lock.json ./
RUN npm ci --cache .npm --prefer-offline
COPY idm-emulator ./
RUN npm run build

FROM node:22-bookworm-slim AS runtime
COPY certs/customer-ca /usr/local/share/idmmw/customer-ca
COPY apt/debian.sources /etc/apt/sources.list.d/debian.sources
ARG CUSTOMER_CA_REQUIRED=false
RUN set -eu; \
  ca_dir=/usr/local/share/idmmw/customer-ca; \
  ca_bundle=/usr/local/share/ca-certificates/idmmw/customer-ca.crt; \
  system_bundle=/etc/ssl/certs/ca-certificates.crt; \
  ca_files=/tmp/idmmw-customer-ca-files; \
  find "$ca_dir" -type f \( -name '*.crt' -o -name '*.pem' \) -print | sort > "$ca_files"; \
  if [ -s "$ca_files" ]; then \
    mkdir -p "$(dirname "$ca_bundle")" /etc/ssl/certs; \
    while IFS= read -r cert_file; do cat "$cert_file"; printf '\n'; done < "$ca_files" > "$ca_bundle"; \
    if command -v update-ca-certificates >/dev/null 2>&1; then update-ca-certificates; fi; \
    if [ -f "$system_bundle" ]; then cat "$ca_bundle" >> "$system_bundle"; else cp "$ca_bundle" "$system_bundle"; fi; \
    if command -v npm >/dev/null 2>&1; then npm config set cafile "$system_bundle" --global; fi; \
  elif [ "$CUSTOMER_CA_REQUIRED" = "true" ]; then \
    echo "CUSTOMER_CA_REQUIRED=true but no certs/customer-ca/*.crt or *.pem was provided" >&2; \
    exit 1; \
  fi; \
  rm -f "$ca_files"
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/idmmw/customer-ca.crt

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3010

RUN groupadd --system idmmw \
  && useradd --system --gid idmmw --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin idmmw

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates openssl \
  && if [ -s /usr/local/share/ca-certificates/idmmw/customer-ca.crt ]; then update-ca-certificates && cat /usr/local/share/ca-certificates/idmmw/customer-ca.crt >> /etc/ssl/certs/ca-certificates.crt; fi \
  && mkdir -p /usr/local/share/ca-certificates/idmmw \
  && touch /usr/local/share/ca-certificates/idmmw/customer-ca.crt \
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
  actual_artifact_sha256="$(cd /app/ui/dist && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')"; \
  printf '%s\n' "$actual_artifact_sha256" > /app/build/runtime-artifact.sha256; \
  chown -R idmmw:idmmw /app

ARG APP_VERSION=0.0.0.0
ARG GIT_REVISION=unknown
ARG SOURCE_CLEAN=false
ARG BUILD_PROVENANCE=unverified-local
ARG RUNTIME_ARTIFACT_SHA256=unknown
ARG IMAGE_CREATED=unknown

RUN set -eu; \
  if [ "$APP_VERSION" != "0.0.0.0" ] && [ "$(cat /app/VERSION)" != "$APP_VERSION" ]; then \
    echo "APP_VERSION does not match /app/VERSION" >&2; \
    exit 1; \
  fi; \
  if [ "$RUNTIME_ARTIFACT_SHA256" != "unknown" ] && [ "$(cat /app/build/runtime-artifact.sha256)" != "$RUNTIME_ARTIFACT_SHA256" ]; then \
    echo "RUNTIME_ARTIFACT_SHA256 does not match /app/ui/dist" >&2; \
    exit 1; \
  fi

LABEL org.opencontainers.image.title="idmMw" \
  org.opencontainers.image.description="Avanpost IDM middleware" \
  org.opencontainers.image.version="${APP_VERSION}" \
  org.opencontainers.image.revision="${GIT_REVISION}" \
  org.opencontainers.image.created="${IMAGE_CREATED}" \
  ru.gkm.source.clean="${SOURCE_CLEAN}" \
  ru.gkm.build.provenance="${BUILD_PROVENANCE}" \
  ru.gkm.runtime-artifact.sha256="${RUNTIME_ARTIFACT_SHA256}"

ENV APP_VERSION=${APP_VERSION}
ENV GIT_REVISION=${GIT_REVISION}
ENV SOURCE_CLEAN=${SOURCE_CLEAN}
ENV BUILD_PROVENANCE=${BUILD_PROVENANCE}
ENV RUNTIME_ARTIFACT_SHA256=${RUNTIME_ARTIFACT_SHA256}
ENV IMAGE_CREATED=${IMAGE_CREATED}

USER idmmw

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const http=require('http');const https=require('https');const tls=process.env.HTTP_TLS_ENABLED==='true';const req=(tls?https:http).request({host:'127.0.0.1',port:process.env.PORT||3010,path:'/health',rejectUnauthorized:false},(res)=>process.exit(res.statusCode>=200&&res.statusCode<400?0:1));req.on('error',()=>process.exit(1));req.end();"

CMD ["node", "dist/main.js"]

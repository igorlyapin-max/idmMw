#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

IMAGE=""
EXPECTED_VERSION="$(tr -d '[:space:]' < VERSION)"
EXPECTED_REVISION="$(git rev-parse HEAD)"
EXPECTED_PROVENANCE="verified"
EXPECTED_SOURCE_CLEAN="true"
EXPECTED_ARTIFACT_SHA256=""
CHECK_RUNTIME="true"
PORT="${PORT:-3218}"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/verify-image-provenance.sh --image IMAGE [options]

Options:
  --version VALUE
  --revision VALUE
  --provenance verified|unverified-local
  --source-clean true|false
  --runtime-artifact-sha256 VALUE
  --port PORT
  --no-runtime
USAGE
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --version)
      EXPECTED_VERSION="${2:-}"
      shift 2
      ;;
    --revision)
      EXPECTED_REVISION="${2:-}"
      shift 2
      ;;
    --provenance)
      EXPECTED_PROVENANCE="${2:-}"
      shift 2
      ;;
    --source-clean)
      EXPECTED_SOURCE_CLEAN="${2:-}"
      shift 2
      ;;
    --runtime-artifact-sha256)
      EXPECTED_ARTIFACT_SHA256="${2:-}"
      shift 2
      ;;
    --port)
      PORT="${2:-}"
      shift 2
      ;;
    --no-runtime)
      CHECK_RUNTIME="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

if [ -z "$IMAGE" ]; then
  usage
  exit 2
fi

if [ -z "$EXPECTED_ARTIFACT_SHA256" ]; then
  log "extract expected runtime artifact digest from image=${IMAGE}"
  EXPECTED_ARTIFACT_SHA256="$(docker run --rm --entrypoint cat "$IMAGE" /app/build/runtime-artifact.sha256 | tr -d '[:space:]')"
fi

if [[ ! "$EXPECTED_ARTIFACT_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Invalid expected runtime artifact digest: ${EXPECTED_ARTIFACT_SHA256}" >&2
  exit 1
fi

label() {
  docker image inspect --format "{{ index .Config.Labels \"$1\" }}" "$IMAGE"
}

require_equal() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [ "$actual" != "$expected" ]; then
    echo "${name} mismatch: expected '${expected}', got '${actual}'" >&2
    exit 1
  fi
}

IMAGE_ID="$(docker image inspect --format '{{.Id}}' "$IMAGE")"
log "verify image labels image=${IMAGE} image-id=${IMAGE_ID}"
require_equal "label org.opencontainers.image.version" "$(label org.opencontainers.image.version)" "$EXPECTED_VERSION"
require_equal "label org.opencontainers.image.revision" "$(label org.opencontainers.image.revision)" "$EXPECTED_REVISION"
require_equal "label ru.gkm.source.clean" "$(label ru.gkm.source.clean)" "$EXPECTED_SOURCE_CLEAN"
require_equal "label ru.gkm.build.provenance" "$(label ru.gkm.build.provenance)" "$EXPECTED_PROVENANCE"
require_equal "label ru.gkm.runtime-artifact.sha256" "$(label ru.gkm.runtime-artifact.sha256)" "$EXPECTED_ARTIFACT_SHA256"
log "verify embedded image files image=${IMAGE}"
require_equal "/app/VERSION" "$(docker run --rm --entrypoint cat "$IMAGE" /app/VERSION)" "$EXPECTED_VERSION"
require_equal "/app/build/runtime-artifact.sha256" "$(docker run --rm --entrypoint cat "$IMAGE" /app/build/runtime-artifact.sha256)" "$EXPECTED_ARTIFACT_SHA256"

if [ "$CHECK_RUNTIME" = "true" ]; then
  CONTAINER_NAME="idmmw-provenance-$$"
  cleanup() {
    docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  }
  trap cleanup EXIT INT TERM

  log "runtime smoke start image=${IMAGE} port=${PORT}"
  docker run -d \
    --name "$CONTAINER_NAME" \
    -p "127.0.0.1:${PORT}:3010" \
    -e NODE_ENV=production \
    -e DATABASE_PROVIDER=sqlite \
    -e DATABASE_URL=file:/tmp/idmmw-provenance.db \
    -e LIGHTWEIGHT_MODE=true \
    -e IDMMW_PROCESSING_MODE=sync \
    -e KAFKA_ENABLED=false \
    -e REDIS_ENABLED=false \
    -e ADMIN_UI_ENABLED=true \
    -e ADMIN_UI_SERVE_STATIC=true \
    -e ADMIN_AUTH_ENABLED=false \
    -e HTTP_TLS_ENABLED=false \
    -e MOCK_IDM_ENABLED=false \
    -e ENCRYPTION_ENABLED=false \
    --entrypoint sh \
    "$IMAGE" \
    -c 'npx prisma db push --schema=prisma/schema.sqlite.prisma --skip-generate && node dist/main.js' >/dev/null

  RUNNING_IMAGE_ID="$(docker inspect --format '{{.Image}}' "$CONTAINER_NAME")"
  require_equal "running image id" "$RUNNING_IMAGE_ID" "$IMAGE_ID"

  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:${PORT}/health" >/tmp/idmmw-health-$$.json 2>/dev/null; then
      break
    fi
    if [ "$(docker inspect --format '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null || echo false)" != "true" ]; then
      echo "Container exited before /health became available" >&2
      docker logs "$CONTAINER_NAME" >&2 || true
      exit 1
    fi
    sleep 0.5
  done

  curl -fsS "http://127.0.0.1:${PORT}/health" >/tmp/idmmw-health-$$.json
  curl -fsS "http://127.0.0.1:${PORT}/about" >/tmp/idmmw-about-$$.json
  curl -fsS "http://127.0.0.1:${PORT}/metrics" | grep -q "idmmw_http_requests_total"

  node - "$EXPECTED_VERSION" "$EXPECTED_REVISION" "$EXPECTED_SOURCE_CLEAN" "$EXPECTED_PROVENANCE" "$EXPECTED_ARTIFACT_SHA256" /tmp/idmmw-health-$$.json /tmp/idmmw-about-$$.json <<'NODE'
const fs = require('fs');
const [version, revision, sourceClean, provenance, artifact, healthPath, aboutPath] = process.argv.slice(2);
const health = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
const about = JSON.parse(fs.readFileSync(aboutPath, 'utf8'));
function assertBuild(label, payload) {
  if (!payload.build) throw new Error(`${label} has no build identity`);
  if (payload.build.version !== version) throw new Error(`${label} version mismatch`);
  if (payload.build.gitRevision !== revision) throw new Error(`${label} revision mismatch`);
  if (String(payload.build.sourceClean) !== sourceClean) throw new Error(`${label} sourceClean mismatch`);
  if (payload.build.provenance !== provenance) throw new Error(`${label} provenance mismatch`);
  if (payload.build.runtimeArtifactSha256 !== artifact) throw new Error(`${label} artifact digest mismatch`);
}
if (health.status !== 'ok') throw new Error('health status is not ok');
assertBuild('health', health);
assertBuild('about', about);
NODE

  rm -f /tmp/idmmw-health-$$.json /tmp/idmmw-about-$$.json
  log "runtime smoke passed image=${IMAGE}"
fi

echo "Image provenance verified for ${IMAGE} (${IMAGE_ID})"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE="dev-sqlite"
IMAGE=""
PRISMA_SCHEMA=""
PUSH_IMAGE="false"
CHECK_RUNTIME=""
DOCKER_PROGRESS="${DOCKER_PROGRESS:-plain}"
KEEP_ARTIFACT_IMAGE="${KEEP_ARTIFACT_IMAGE:-false}"
CUSTOMER_CA_REQUIRED="${CUSTOMER_CA_REQUIRED:-false}"

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/build-verified-image.sh [options]

Options:
  --profile dev-sqlite|dev-postgres|ha-yugabyte|ha-cockroach|sqlite-test
  --image IMAGE
  --prisma-schema PATH
  --push
  --no-runtime

Environment:
  CUSTOMER_CA_REQUIRED=true  Fail Docker build when certs/customer-ca has no *.crt or *.pem
USAGE
}

log() {
  printf '[%s] %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$*" >&2
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --profile)
      PROFILE="${2:-}"
      shift 2
      ;;
    --image)
      IMAGE="${2:-}"
      shift 2
      ;;
    --prisma-schema)
      PRISMA_SCHEMA="${2:-}"
      shift 2
      ;;
    --push)
      PUSH_IMAGE="true"
      shift
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

case "$PROFILE" in
  dev-sqlite)
    DEFAULT_SCHEMA="prisma/schema.sqlite.prisma"
    DEFAULT_IMAGE="idmmw:dev-sqlite"
    DEFAULT_RUNTIME_CHECK="true"
    ;;
  dev-postgres)
    DEFAULT_SCHEMA="prisma/schema.prisma"
    DEFAULT_IMAGE="idmmw:dev-postgres"
    DEFAULT_RUNTIME_CHECK="false"
    ;;
  ha-yugabyte)
    DEFAULT_SCHEMA="prisma/schema.prisma"
    DEFAULT_IMAGE="idmmw:ha-yugabyte"
    DEFAULT_RUNTIME_CHECK="false"
    ;;
  ha-cockroach)
    DEFAULT_SCHEMA="prisma/schema.cockroach.prisma"
    DEFAULT_IMAGE="idmmw:ha-cockroach"
    DEFAULT_RUNTIME_CHECK="false"
    ;;
  sqlite-test)
    DEFAULT_SCHEMA="prisma/schema.sqlite.prisma"
    DEFAULT_IMAGE="idmmw:sqlite-test"
    DEFAULT_RUNTIME_CHECK="true"
    ;;
  *)
    usage
    exit 2
    ;;
esac

PRISMA_SCHEMA="${PRISMA_SCHEMA:-$DEFAULT_SCHEMA}"
IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
CHECK_RUNTIME="${CHECK_RUNTIME:-$DEFAULT_RUNTIME_CHECK}"
VERSION="$(tr -d '[:space:]' < VERSION)"
REVISION="$(git rev-parse HEAD)"
CREATED="$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
ARTIFACT_IMAGE="idmmw-artifact:${VERSION//./-}-${REVISION:0:12}-$$"

cleanup() {
  if [ "$KEEP_ARTIFACT_IMAGE" != "true" ]; then
    docker image rm "$ARTIFACT_IMAGE" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

build_image() {
  local target_image="$1"
  local provenance="$2"
  local artifact_sha256="$3"

  log "docker build start image=${target_image} profile=${PROFILE} schema=${PRISMA_SCHEMA} provenance=${provenance}"
  docker build \
    --progress "$DOCKER_PROGRESS" \
    --build-arg PRISMA_SCHEMA="$PRISMA_SCHEMA" \
    --build-arg CUSTOMER_CA_REQUIRED="$CUSTOMER_CA_REQUIRED" \
    --build-arg APP_VERSION="$VERSION" \
    --build-arg GIT_REVISION="$REVISION" \
    --build-arg SOURCE_CLEAN=true \
    --build-arg BUILD_PROVENANCE="$provenance" \
    --build-arg RUNTIME_ARTIFACT_SHA256="$artifact_sha256" \
    --build-arg IMAGE_CREATED="$CREATED" \
    -t "$target_image" .
}

extract_artifact_sha256() {
  local image="$1"
  local artifact_sha256

  log "extract runtime artifact digest from image=${image}"
  artifact_sha256="$(docker run --rm --entrypoint cat "$image" /app/build/runtime-artifact.sha256 | tr -d '[:space:]')"
  if [[ ! "$artifact_sha256" =~ ^[0-9a-f]{64}$ ]]; then
    echo "Invalid runtime artifact digest extracted from ${image}: ${artifact_sha256}" >&2
    exit 1
  fi
  printf '%s\n' "$artifact_sha256"
}

if [[ ! "$VERSION" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] || [ "$VERSION" = "00.00.00.00" ]; then
  echo "Invalid release VERSION: $VERSION" >&2
  exit 1
fi

case "$CUSTOMER_CA_REQUIRED" in
  true|false)
    ;;
  *)
    echo "CUSTOMER_CA_REQUIRED must be true or false" >&2
    exit 2
    ;;
esac

log "preflight start image=${IMAGE} version=${VERSION} revision=${REVISION} runtime-check=${CHECK_RUNTIME} customer-ca-required=${CUSTOMER_CA_REQUIRED}"

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Tracked source is dirty; commit or reset tracked changes before verified image build" >&2
  exit 1
fi

case "$(git status --porcelain --untracked-files=all)" in
  ""|"?? AGENTS.md")
    ;;
  *)
    echo "Unexpected untracked files are present; verified image build allows only local AGENTS.md" >&2
    git status --short
    exit 1
    ;;
esac

log "preflight passed"
build_image "$ARTIFACT_IMAGE" "unverified-local" "unknown"
ARTIFACT_SHA256="$(extract_artifact_sha256 "$ARTIFACT_IMAGE")"
log "runtime artifact digest=${ARTIFACT_SHA256}"

build_image "$IMAGE" "verified" "$ARTIFACT_SHA256"

VERIFY_ARGS=(
  --image "$IMAGE"
  --version "$VERSION"
  --revision "$REVISION"
  --source-clean true
  --provenance verified
  --runtime-artifact-sha256 "$ARTIFACT_SHA256"
)
if [ "$CHECK_RUNTIME" != "true" ]; then
  VERIFY_ARGS+=(--no-runtime)
fi

log "verify image provenance start image=${IMAGE}"
scripts/verify-image-provenance.sh "${VERIFY_ARGS[@]}"

if [ "$PUSH_IMAGE" = "true" ]; then
  log "docker push start image=${IMAGE}"
  docker push "$IMAGE"
fi

log "verified image build completed image=${IMAGE}"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

PROFILE="dev-sqlite"
IMAGE=""
PRISMA_SCHEMA=""
PUSH_IMAGE="false"
CHECK_RUNTIME=""

usage() {
  cat >&2 <<'USAGE'
Usage: scripts/build-verified-image.sh [options]

Options:
  --profile dev-sqlite|dev-postgres|ha-yugabyte|ha-cockroach|sqlite-test
  --image IMAGE
  --prisma-schema PATH
  --push
  --no-runtime
USAGE
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

if [[ ! "$VERSION" =~ ^[0-9]{2}\.[0-9]{2}\.[0-9]{2}\.[0-9]{2}$ ]] || [ "$VERSION" = "00.00.00.00" ]; then
  echo "Invalid release VERSION: $VERSION" >&2
  exit 1
fi

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

if [ ! -d ui/node_modules ]; then
  npm --prefix ui ci --cache ui/.npm --prefer-offline
fi
npm --prefix ui run build
ARTIFACT_SHA256="$(scripts/runtime-artifact-sha256.sh ui/dist)"

docker build \
  --build-arg PRISMA_SCHEMA="$PRISMA_SCHEMA" \
  --build-arg APP_VERSION="$VERSION" \
  --build-arg GIT_REVISION="$REVISION" \
  --build-arg SOURCE_CLEAN=true \
  --build-arg BUILD_PROVENANCE=verified \
  --build-arg RUNTIME_ARTIFACT_SHA256="$ARTIFACT_SHA256" \
  --build-arg IMAGE_CREATED="$CREATED" \
  -t "$IMAGE" .

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
scripts/verify-image-provenance.sh "${VERIFY_ARGS[@]}"

if [ "$PUSH_IMAGE" = "true" ]; then
  docker push "$IMAGE"
fi

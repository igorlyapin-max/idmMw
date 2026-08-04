#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ARTIFACT_DIR="${1:-ui/dist}"

if [ ! -d "$ARTIFACT_DIR" ]; then
  echo "Runtime artifact directory not found: $ARTIFACT_DIR" >&2
  exit 1
fi

(
  cd "$ARTIFACT_DIR"
  find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}'
)

#!/usr/bin/env bash
# migrate-branded-assets.sh
#
# Moves community-branded notification images from the tracked assets/
# directory into the gitignored overrides/assets/ directory so they
# stay on this host but no longer appear in the public repository.
#
# Safe to run multiple times (skips files that already exist in overrides).
#
# Usage (on the prod host):
#   cd /home/yogev/red-alerts-notifier
#   bash scripts/migrate-branded-assets.sh
#   git pull
#   docker compose up -d --build poller notifier-worker

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$REPO_ROOT/poller/assets"
DST="$REPO_ROOT/poller/overrides/assets"

BRANDED_FILES=(
  active-alert.jpeg
  all-clear.jpeg
  drone.jpeg
  earthquake.jpeg
  pre-alert.jpeg
  stay_nearby.jpeg
)

mkdir -p "$DST"

copied=0
skipped=0

for f in "${BRANDED_FILES[@]}"; do
  src_path="$SRC/$f"
  dst_path="$DST/$f"

  if [[ ! -f "$src_path" ]]; then
    echo "skip: $f (not found in assets/)"
    ((skipped++))
    continue
  fi

  if [[ -f "$dst_path" ]]; then
    echo "skip: $f (already in overrides/)"
    ((skipped++))
    continue
  fi

  cp "$src_path" "$dst_path"
  echo " ok: $f -> overrides/assets/"
  ((copied++))
done

echo ""
echo "done: $copied copied, $skipped skipped"
echo ""
echo "next steps:"
echo "  git pull"
echo "  docker compose up -d --build poller notifier-worker"

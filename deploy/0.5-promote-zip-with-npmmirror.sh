#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${ARCHIVE:-/opt/simple-live-sync-site-master.zip}"
PROJECT_DIR="/opt/simple-live-sync"
STAGING_DIR="/opt/simple-live-sync.next"
NPM_REGISTRY="${NPM_REGISTRY:-https://registry.npmmirror.com}"

test -f "$ARCHIVE"
unzip -tq "$ARCHIVE" >/dev/null
if unzip -Z1 "$ARCHIVE" | grep -Eq '(^/|(^|/)\.\.(/|$))'; then
  printf 'Archive contains an unsafe path.\n' >&2
  exit 1
fi

rm -rf "$STAGING_DIR"
install -d -m 0755 "$STAGING_DIR"
unzip -q "$ARCHIVE" -d "$STAGING_DIR"

source_dir="$(find "$STAGING_DIR" -mindepth 1 -maxdepth 1 -type d -print -quit)"
if [[ -z "$source_dir" || ! -f "$source_dir/package.json" || ! -f "$source_dir/package-lock.json" ]]; then
  printf 'Archive must contain one project directory with package.json and package-lock.json.\n' >&2
  exit 1
fi

cd "$source_dir"
npm ci --registry="$NPM_REGISTRY"
npm run build:web
npm run build:node
npm prune --omit=dev --registry="$NPM_REGISTRY"
test -f dist/server.js

systemctl stop simple-live-sync.service
backup_dir="/opt/simple-live-sync.previous-$(date -u +%Y%m%dT%H%M%SZ)"
mv "$PROJECT_DIR" "$backup_dir"
mv "$source_dir" "$PROJECT_DIR"
rmdir "$STAGING_DIR"
systemctl start simple-live-sync.service

for attempt in {1..10}; do
  if curl --fail --silent --show-error http://127.0.0.1:8787/health?format=json; then
    printf '\nPrevious release retained at %s\n' "$backup_dir"
    exit 0
  fi
  sleep 1
done

printf 'The promoted service did not become healthy; previous release is at %s\n' "$backup_dir" >&2
exit 1

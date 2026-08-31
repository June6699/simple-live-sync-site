#!/usr/bin/env bash
set -euo pipefail

ARCHIVE="${ARCHIVE:-/root/simple-live-sync-site.local.tar.gz}"
ARCHIVE_SHA256="${ARCHIVE_SHA256:?Set ARCHIVE_SHA256 to the local archive SHA-256}"
PROJECT_DIR="/opt/simple-live-sync"
STAGING_DIR="/opt/simple-live-sync.next"

actual_sha256="$(sha256sum "$ARCHIVE" | awk '{print $1}')"
if [[ "$actual_sha256" != "$ARCHIVE_SHA256" ]]; then
  printf 'Archive SHA-256 mismatch.\n' >&2
  exit 1
fi

rm -rf "$STAGING_DIR"
install -d -m 0755 "$STAGING_DIR"
tar -xzf "$ARCHIVE" -C "$STAGING_DIR"

if [[ ! -f "$STAGING_DIR/dist/server.js" || ! -f "$STAGING_DIR/package.json" ]]; then
  printf 'The local archive is missing the built Node service or package manifest.\n' >&2
  exit 1
fi
if [[ ! -d "$PROJECT_DIR/node_modules" ]]; then
  printf 'The current production dependency directory is missing.\n' >&2
  exit 1
fi

# Dependencies were previously installed on this Linux host. Preserve them so
# this release never needs to fetch source or packages from the public network.
cp -a "$PROJECT_DIR/node_modules" "$STAGING_DIR/node_modules"

systemctl stop simple-live-sync.service
backup_dir="/opt/simple-live-sync.previous-$(date -u +%Y%m%dT%H%M%SZ)"
mv "$PROJECT_DIR" "$backup_dir"
mv "$STAGING_DIR" "$PROJECT_DIR"
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

#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'
umask 0077

ENV_FILE="${SIMPLE_LIVE_SYNC_ENV_FILE:-/etc/simple-live-sync/simple-live-sync.env}"
if [[ -e "$ENV_FILE" ]]; then
  case "$(stat -c '%u:%a' "$ENV_FILE")" in
    0:400|0:600) ;;
    *)
      printf 'Environment file must be root-owned with mode 0400 or 0600: %s\n' "$ENV_FILE" >&2
      exit 1
      ;;
  esac
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

METRICS_DB_PATH="${METRICS_DB_PATH:-/var/lib/simple-live-sync/metrics.sqlite}"
BACKUP_DIR="/var/backups/simple-live-sync"

case "$METRICS_DB_PATH" in
  /var/lib/simple-live-sync/*.sqlite) ;;
  *)
    printf 'Refusing to back up an unexpected database path: %s\n' "$METRICS_DB_PATH" >&2
    exit 1
    ;;
esac

if [[ ! -f "$METRICS_DB_PATH" ]]; then
  printf 'No metrics database exists yet; backup skipped.\n'
  exit 0
fi

command -v sqlite3 >/dev/null
install -d -m 0700 "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%S%N)"
backup_path="$BACKUP_DIR/metrics-$timestamp.sqlite"
sqlite3 "$METRICS_DB_PATH" ".timeout 10000" ".backup '$backup_path'"
chmod 0600 "$backup_path"

if [[ "$(sqlite3 "$backup_path" 'PRAGMA quick_check;')" != "ok" ]]; then
  rm -f -- "$backup_path"
  printf 'Backup verification failed.\n' >&2
  exit 1
fi

printf 'Metrics backup created: %s\n' "$backup_path"

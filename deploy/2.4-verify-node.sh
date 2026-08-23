#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
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

METRICS_ENABLED="${METRICS_ENABLED:-false}"
METRICS_DB_PATH="${METRICS_DB_PATH:-/var/lib/simple-live-sync/metrics.sqlite}"

cd "$PROJECT_ROOT"
systemctl is-active --quiet simple-live-sync.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
nginx -t
systemctl is-enabled --quiet certbot.timer
curl --fail --silent --show-error https://sync.furry.mo.cn/health

if [[ "$METRICS_ENABLED" == "true" ]]; then
  test -s "$METRICS_DB_PATH"
  test "$(sqlite3 "$METRICS_DB_PATH" 'PRAGMA quick_check;')" = "ok"
fi

http_smoke_args=(node deploy/2.6-http-smoke.mjs https://sync.furry.mo.cn)
if [[ "$METRICS_ENABLED" == "true" ]]; then
  http_smoke_args+=(--expect-metrics)
fi
"${http_smoke_args[@]}"
node deploy/2.2-public-smoke.mjs wss://sync.furry.mo.cn/sync
node deploy/2.3-backend-isolation.mjs \
  wss://sync.furry.mo.cn/sync \
  wss://simple-live-sync.3439394104.workers.dev/sync

printf '\nNode public verification passed.\n'

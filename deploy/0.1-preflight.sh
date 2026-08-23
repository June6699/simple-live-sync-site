#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOMAIN="sync.furry.mo.cn"
EXPECTED_IP="186.241.120.176"
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
GEOIP_DB_PATH="${GEOIP_DB_PATH:-/var/lib/GeoIP/GeoLite2-City.mmdb}"
IP_HASH_SECRET="${IP_HASH_SECRET:-}"

case "$METRICS_ENABLED" in
  true|false) ;;
  *)
    printf 'METRICS_ENABLED must be true or false.\n' >&2
    exit 1
    ;;
esac

case "$METRICS_DB_PATH" in
  /var/lib/simple-live-sync/*.sqlite) ;;
  *)
    printf 'METRICS_DB_PATH must stay under /var/lib/simple-live-sync and end in .sqlite.\n' >&2
    exit 1
    ;;
esac

if [[ "$GEOIP_DB_PATH" != "/var/lib/GeoIP/GeoLite2-City.mmdb" ]]; then
  printf 'GEOIP_DB_PATH must be /var/lib/GeoIP/GeoLite2-City.mmdb for the Nginx and Node paths to agree.\n' >&2
  exit 1
fi

for command_name in docker nginx certbot curl getent stat systemctl; do
  command -v "$command_name" >/dev/null
done

cd "$PROJECT_ROOT"
docker compose version
nginx -t

if [[ "$METRICS_ENABLED" == "true" ]] && (( ${#IP_HASH_SECRET} < 32 )); then
  printf 'IP_HASH_SECRET must contain at least 32 characters when metrics are enabled.\n' >&2
  exit 1
fi

if [[ ! -r "$GEOIP_DB_PATH" ]]; then
  printf 'GeoIP database is missing or unreadable: %s\n' "$GEOIP_DB_PATH" >&2
  exit 1
fi
if [[ ! -f /etc/GeoIP.conf ]]; then
  printf 'MaxMind configuration is missing: /etc/GeoIP.conf\n' >&2
  exit 1
fi
case "$(stat -c '%u:%a' /etc/GeoIP.conf)" in
  0:400|0:600) ;;
  *)
    printf '/etc/GeoIP.conf must be root-owned with mode 0400 or 0600.\n' >&2
    exit 1
    ;;
esac
nginx_dump="$(nginx -T 2>&1)"
nginx_build="$(nginx -V 2>&1)"
if ! grep -Eq 'load_module[[:space:]].*ngx_http_geoip2_module' <<<"$nginx_dump" \
  && ! grep -q 'http_geoip2' <<<"$nginx_build"; then
  printf 'Nginx GeoIP2 module is not loaded. Install libnginx-mod-http-geoip2 first.\n' >&2
  exit 1
fi

if [[ -f "$METRICS_DB_PATH" ]]; then
  command -v sqlite3 >/dev/null
  if [[ "$(sqlite3 "$METRICS_DB_PATH" 'PRAGMA quick_check;')" != "ok" ]]; then
    printf 'SQLite quick_check failed for %s\n' "$METRICS_DB_PATH" >&2
    exit 1
  fi
fi

resolved_ips="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u)"
if ! grep -Fxq "$EXPECTED_IP" <<<"$resolved_ips"; then
  printf 'Expected %s to resolve to %s, got:\n%s\n' "$DOMAIN" "$EXPECTED_IP" "$resolved_ips" >&2
  exit 1
fi

printf 'Preflight passed for %s -> %s\n' "$DOMAIN" "$EXPECTED_IP"

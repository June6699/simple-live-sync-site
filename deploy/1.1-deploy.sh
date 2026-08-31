#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

if [[ "${EUID}" -ne 0 ]]; then
  printf 'Run this deployment as root.\n' >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOMAIN="sync.furry.mo.cn"
SITE_NAME="sync.furry.mo.cn.conf"
AVAILABLE_PATH="/etc/nginx/sites-available/$SITE_NAME"
ENABLED_PATH="/etc/nginx/sites-enabled/$SITE_NAME"
CERT_PATH="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"
RENEW_HOOK="/etc/letsencrypt/renewal-hooks/deploy/simple-live-sync-reload-nginx"
ENV_FILE="${SIMPLE_LIVE_SYNC_ENV_FILE:-/etc/simple-live-sync/simple-live-sync.env}"
STATE_DIR="/var/lib/simple-live-sync"
NGINX_BACKUP_DIR="/var/backups/simple-live-sync/nginx"

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

export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://sync.furry.mo.cn}"
export METRICS_ENABLED="${METRICS_ENABLED:-true}"
export METRICS_DB_PATH="${METRICS_DB_PATH:-$STATE_DIR/metrics.sqlite}"
export GEOIP_DB_PATH="${GEOIP_DB_PATH:-/var/lib/GeoIP/GeoLite2-City.mmdb}"
export IP_HASH_SECRET="${IP_HASH_SECRET:-}"
if [[ -z "${SIMPLE_LIVE_SYNC_IMAGE_TAG:-}" ]]; then
  if command -v git >/dev/null && git -C "$PROJECT_ROOT" rev-parse --verify HEAD >/dev/null 2>&1; then
    SIMPLE_LIVE_SYNC_IMAGE_TAG="$(git -C "$PROJECT_ROOT" rev-parse --short=12 HEAD)"
  else
    SIMPLE_LIVE_SYNC_IMAGE_TAG="current"
  fi
fi
export SIMPLE_LIVE_SYNC_IMAGE_TAG

install_nginx_site() {
  local source_config="$1"
  local previous_config=""

  install -d -m 0700 "$NGINX_BACKUP_DIR"
  if [[ -e "$AVAILABLE_PATH" ]]; then
    previous_config="$NGINX_BACKUP_DIR/$SITE_NAME.$(date -u +%Y%m%dT%H%M%S%N)"
    cp -a -- "$AVAILABLE_PATH" "$previous_config"
  fi

  install -m 0644 "$source_config" "$AVAILABLE_PATH"
  ln -sfn "$AVAILABLE_PATH" "$ENABLED_PATH"
  if ! nginx -t; then
    if [[ -n "$previous_config" ]]; then
      install -m 0644 "$previous_config" "$AVAILABLE_PATH"
      ln -sfn "$AVAILABLE_PATH" "$ENABLED_PATH"
    else
      rm -f -- "$ENABLED_PATH" "$AVAILABLE_PATH"
    fi
    nginx -t
    printf 'Nginx candidate was rejected; the previous configuration was restored.\n' >&2
    return 1
  fi
  systemctl reload nginx
}

cd "$PROJECT_ROOT"
bash deploy/0.1-preflight.sh

if systemctl is-active --quiet simple-live-sync.service; then
  printf 'The systemd fallback is active. Stop it before deploying the Docker service.\n' >&2
  exit 1
fi

docker compose build
bash deploy/0.2-backup-metrics.sh
install -d -m 0750 "$STATE_DIR"
docker compose run --rm --no-deps --user root --entrypoint chown sync \
  -R node:node /app/data
chmod 0750 "$STATE_DIR"
docker compose up -d --remove-orphans

for _ in {1..20}; do
  if curl --fail --silent http://127.0.0.1:8787/health >/dev/null; then
    break
  fi
  sleep 1
done
curl --fail --silent --show-error http://127.0.0.1:8787/health >/dev/null

if [[ ! -f "$CERT_PATH" ]]; then
  install -d -m 0755 /var/www/html
  install_nginx_site deploy/nginx/sync.furry.mo.cn.bootstrap.conf
  certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --domain "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email
fi

install -m 0755 deploy/1.2-certbot-renew-hook.sh "$RENEW_HOOK"
install_nginx_site deploy/nginx/sync.furry.mo.cn.conf
curl --fail --silent --show-error "https://$DOMAIN/health" >/dev/null

http_smoke_args=(node deploy/2.6-http-smoke.mjs "https://$DOMAIN")
if [[ "$METRICS_ENABLED" == "true" ]]; then
  http_smoke_args+=(--expect-metrics)
fi
docker compose run --rm --no-deps sync "${http_smoke_args[@]}"
docker compose run --rm --no-deps sync \
  node deploy/2.2-public-smoke.mjs "wss://$DOMAIN/sync" --ping-only

printf 'Deployment completed: https://%s\n' "$DOMAIN"

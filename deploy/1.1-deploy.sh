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

cd "$PROJECT_ROOT"
bash deploy/0.1-preflight.sh
docker compose up -d --build --remove-orphans
curl --fail --silent --show-error http://127.0.0.1:8787/health >/dev/null

if [[ ! -f "$CERT_PATH" ]]; then
  install -d -m 0755 /var/www/html
  install -m 0644 deploy/nginx/sync.furry.mo.cn.bootstrap.conf "$AVAILABLE_PATH"
  ln -sfn "$AVAILABLE_PATH" "$ENABLED_PATH"
  nginx -t
  systemctl reload nginx
  certbot certonly \
    --webroot \
    --webroot-path /var/www/html \
    --domain "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --register-unsafely-without-email
fi

install -m 0755 deploy/1.2-certbot-renew-hook.sh "$RENEW_HOOK"
install -m 0644 deploy/nginx/sync.furry.mo.cn.conf "$AVAILABLE_PATH"
ln -sfn "$AVAILABLE_PATH" "$ENABLED_PATH"
nginx -t
systemctl reload nginx
curl --fail --silent --show-error "https://$DOMAIN/health" >/dev/null

printf 'Deployment completed: https://%s\n' "$DOMAIN"

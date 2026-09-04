#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-june6699.top}"
WWW_DOMAIN="${WWW_DOMAIN:-www.${DOMAIN}}"
ENV_FILE="/etc/simple-live-sync/simple-live-sync.env"
NGINX_FILE="/etc/nginx/conf.d/${DOMAIN}.conf"
BOOTSTRAP_FILE="/etc/nginx/conf.d/${DOMAIN}.bootstrap.conf"
BACKUP_DIR="/var/backups/simple-live-sync/nginx"

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'DOMAIN must contain only letters, digits, dots, and hyphens.\n' >&2
  exit 2
fi
if [[ ! "$WWW_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'WWW_DOMAIN must contain only letters, digits, dots, and hyphens.\n' >&2
  exit 2
fi
GEOIP_DB_PATH="/var/lib/GeoIP/GeoLite2-City.mmdb"
if [[ ! -r "$GEOIP_DB_PATH" ]]; then
  printf 'GeoIP database is missing or unreadable: %s\n' "$GEOIP_DB_PATH" >&2
  exit 1
fi
nginx_dump="$(nginx -T 2>&1 || true)"
if ! grep -q 'ngx_http_geoip2_module' <<<"$nginx_dump"; then
  printf 'Nginx GeoIP2 module is not loaded. Install libnginx-mod-http-geoip2 first.\n' >&2
  exit 1
fi

# QQ is hosted by OpenClaw; WeChat runs in its own tmux session.
systemctl --user disable --now openclaw-gateway.service
systemctl disable --now xianyu-bot.service
systemctl disable --now xianyu-weekly-report.timer
tmux kill-session -t wechat-bot 2>/dev/null || true

install -d -m 0750 /etc/simple-live-sync
existing_secret=""
if [[ -f "$ENV_FILE" ]]; then
  existing_secret="$(sed -n 's/^IP_HASH_SECRET=//p' "$ENV_FILE" | head -n 1)"
fi
if [[ -z "$existing_secret" ]]; then
  existing_secret="$(openssl rand -hex 32)"
fi
cat >"$ENV_FILE" <<ENV
PUBLIC_ORIGIN=https://${DOMAIN}
METRICS_ENABLED=true
METRICS_DB_PATH=/var/lib/simple-live-sync/metrics.sqlite
GEOIP_DB_PATH=/var/lib/GeoIP/GeoLite2-City.mmdb
IP_HASH_SECRET=${existing_secret}
ENV
chmod 0600 "$ENV_FILE"

install -d -m 0700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
if [[ -f "$NGINX_FILE" ]]; then
  cp -a "$NGINX_FILE" "$BACKUP_DIR/$(basename "$NGINX_FILE").$stamp"
fi
if [[ -f "$BOOTSTRAP_FILE" ]]; then
  cp -a "$BOOTSTRAP_FILE" "$BACKUP_DIR/$(basename "$BOOTSTRAP_FILE").$stamp"
  mv "$BOOTSTRAP_FILE" "$BOOTSTRAP_FILE.disabled.$stamp"
fi

cat >"$NGINX_FILE" <<'NGINX'
geoip2 /var/lib/GeoIP/GeoLite2-City.mmdb {
    auto_reload 1h;
    $geoip2_country_code default="" country iso_code;
    $geoip2_region_code default="" subdivisions 0 iso_code;
}

server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__ __WWW_DOMAIN__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location = /sync {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Geo-Country $geoip2_country_code;
        proxy_set_header X-Geo-Region $geoip2_region_code;
        proxy_set_header Forwarded "";
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header True-Client-IP "";
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 75s;
        proxy_send_timeout 75s;
        proxy_buffering off;
    }

    location ^~ /api/ {
        client_max_body_size 64k;
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Geo-Country $geoip2_country_code;
        proxy_set_header X-Geo-Region $geoip2_region_code;
        proxy_set_header Forwarded "";
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header True-Client-IP "";
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Geo-Country $geoip2_country_code;
        proxy_set_header X-Geo-Region $geoip2_region_code;
        proxy_set_header Forwarded "";
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header True-Client-IP "";
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
NGINX

sed -i "s/__DOMAIN__/${DOMAIN}/g" "$NGINX_FILE"
sed -i "s/__WWW_DOMAIN__/${WWW_DOMAIN}/g" "$NGINX_FILE"
systemctl restart simple-live-sync.service
nginx -t
systemctl reload nginx
for attempt in {1..10}; do
  if curl --fail --silent --show-error -H "Host: ${DOMAIN}" http://127.0.0.1/health?format=json; then
    exit 0
  fi
  sleep 1
done

printf 'The service did not become ready behind Nginx.\n' >&2
exit 1

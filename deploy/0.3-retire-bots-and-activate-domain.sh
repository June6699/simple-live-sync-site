#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-june6699.top}"
ENV_FILE="/etc/simple-live-sync/simple-live-sync.env"
NGINX_FILE="/etc/nginx/conf.d/${DOMAIN}.bootstrap.conf"

if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]]; then
  printf 'DOMAIN must contain only letters, digits, dots, and hyphens.\n' >&2
  exit 2
fi

# QQ is hosted by OpenClaw; WeChat runs in its own tmux session.
systemctl --user disable --now openclaw-gateway.service
systemctl disable --now xianyu-bot.service
systemctl disable --now xianyu-weekly-report.timer
tmux kill-session -t wechat-bot 2>/dev/null || true

install -d -m 0750 /etc/simple-live-sync
cat >"$ENV_FILE" <<ENV
PUBLIC_ORIGIN=https://${DOMAIN}
METRICS_ENABLED=false
METRICS_DB_PATH=/var/lib/simple-live-sync/metrics.sqlite
GEOIP_DB_PATH=/var/lib/GeoIP/GeoLite2-City.mmdb
ENV
chmod 0600 "$ENV_FILE"

cat >"$NGINX_FILE" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

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
        proxy_set_header X-Geo-Country "";
        proxy_set_header X-Geo-Region "";
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
        proxy_set_header X-Geo-Country "";
        proxy_set_header X-Geo-Region "";
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
        proxy_set_header X-Geo-Country "";
        proxy_set_header X-Geo-Region "";
        proxy_set_header Forwarded "";
        proxy_set_header CF-Connecting-IP "";
        proxy_set_header True-Client-IP "";
        proxy_read_timeout 30s;
        proxy_send_timeout 30s;
    }
}
NGINX

sed -i "s/__DOMAIN__/${DOMAIN}/g" "$NGINX_FILE"
systemctl restart simple-live-sync.service
nginx -t
systemctl reload nginx
curl --fail --silent --show-error -H "Host: ${DOMAIN}" http://127.0.0.1/health?format=json

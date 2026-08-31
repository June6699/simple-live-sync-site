#!/usr/bin/env bash
set -euo pipefail

REPOSITORY_URL="${REPOSITORY_URL:-https://github.com/June6699/simple-live-sync-site.git}"
REVISION="${REVISION:?Set REVISION to the Git commit to deploy}"
PROJECT_DIR="${PROJECT_DIR:-/opt/simple-live-sync}"
ENV_FILE="/etc/simple-live-sync/simple-live-sync.env"
UNIT_FILE="/etc/systemd/system/simple-live-sync.service"
NGINX_FILE="/etc/nginx/conf.d/sync.furry.mo.cn.bootstrap.conf"

missing_packages=()
for package_name in certbot sqlite3; do
  if ! dpkg-query -W -f='${db:Status-Status}' "$package_name" 2>/dev/null | grep -Fxq installed; then
    missing_packages+=("$package_name")
  fi
done
if (( ${#missing_packages[@]} > 0 )); then
  apt-get update
  apt-get install -y "${missing_packages[@]}"
fi

if [[ -d "$PROJECT_DIR/.git" ]]; then
  if ! git -C "$PROJECT_DIR" cat-file -e "$REVISION^{commit}" 2>/dev/null; then
    git -C "$PROJECT_DIR" fetch --depth=1 origin "$REVISION"
  fi
else
  if [[ -e "$PROJECT_DIR" ]]; then
    printf 'Refusing to replace non-Git project directory: %s\n' "$PROJECT_DIR" >&2
    exit 1
  fi
  git clone --no-checkout "$REPOSITORY_URL" "$PROJECT_DIR"
  git -C "$PROJECT_DIR" fetch --depth=1 origin "$REVISION"
fi

git -C "$PROJECT_DIR" checkout --detach "$REVISION"

cd "$PROJECT_DIR"
npm ci
npm run build:web
npm run build:node
npm prune --omit=dev

install -d -m 0750 /etc/simple-live-sync
install -d -m 0755 /var/lib/GeoIP
install -d -m 0755 /var/www/html
if [[ ! -e "$ENV_FILE" ]]; then
  install -m 0600 /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<'ENV'
PUBLIC_ORIGIN=https://sync.furry.mo.cn
METRICS_ENABLED=false
METRICS_DB_PATH=/var/lib/simple-live-sync/metrics.sqlite
GEOIP_DB_PATH=/var/lib/GeoIP/GeoLite2-City.mmdb
ENV
fi

install -m 0644 deploy/simple-live-sync.service "$UNIT_FILE"
systemctl daemon-reload
systemctl enable --now simple-live-sync.service

cat >"$NGINX_FILE" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name sync.furry.mo.cn;

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

nginx -t
systemctl reload nginx
curl --fail --silent --show-error http://127.0.0.1:8787/health?format=json

#!/usr/bin/env bash
set -euo pipefail

DOMAIN="${DOMAIN:-june6699.top}"
NGINX_FILE="/etc/nginx/conf.d/${DOMAIN}.bootstrap.conf"
BACKUP_DIR="/var/backups/simple-live-sync/nginx"

test -f "/etc/letsencrypt/live/${DOMAIN}/fullchain.pem"
test -f "/etc/letsencrypt/live/${DOMAIN}/privkey.pem"
test -f /etc/letsencrypt/options-ssl-nginx.conf
test -f /etc/letsencrypt/ssl-dhparams.pem

install -d -m 0700 "$BACKUP_DIR"
if [[ -f "$NGINX_FILE" ]]; then
  cp -a "$NGINX_FILE" "$BACKUP_DIR/$(basename "$NGINX_FILE").$(date -u +%Y%m%dT%H%M%SZ)"
fi

cat >"$NGINX_FILE" <<'NGINX'
server {
    listen 80;
    listen [::]:80;
    server_name __DOMAIN__;

    location ^~ /.well-known/acme-challenge/ {
        root /var/www/html;
        default_type text/plain;
    }

    location / {
        return 301 https://$host$request_uri;
    }
}

server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name __DOMAIN__;

    ssl_certificate /etc/letsencrypt/live/__DOMAIN__/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/__DOMAIN__/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

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
nginx -t
systemctl reload nginx

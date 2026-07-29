#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
systemctl is-active --quiet simple-live-sync.service
curl --fail --silent --show-error http://127.0.0.1:8787/health
nginx -t
systemctl is-enabled --quiet certbot.timer
curl --fail --silent --show-error https://sync.furry.mo.cn/health
node deploy/2.2-public-smoke.mjs wss://sync.furry.mo.cn/sync
node deploy/2.3-backend-isolation.mjs \
  wss://sync.furry.mo.cn/sync \
  wss://simple-live-sync.3439394104.workers.dev/sync

printf '\nNode public verification passed.\n'

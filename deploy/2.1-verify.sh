#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

cd "$PROJECT_ROOT"
docker compose ps
docker compose exec -T sync node -e \
  "fetch('http://127.0.0.1:8787/health').then(async r=>{if(!r.ok)process.exit(1);const d=await r.json();if(d.status!==true)process.exit(1)}).catch(()=>process.exit(1))"
nginx -t
systemctl is-enabled --quiet certbot.timer
curl --fail --silent --show-error https://sync.furry.mo.cn/health
docker compose run --rm --no-deps sync \
  node deploy/2.2-public-smoke.mjs wss://sync.furry.mo.cn/sync
docker compose run --rm --no-deps sync \
  node deploy/2.3-backend-isolation.mjs \
  wss://sync.furry.mo.cn/sync \
  wss://simple-live-sync.3439394104.workers.dev/sync

printf '\nPublic verification passed.\n'

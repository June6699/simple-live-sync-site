#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="/etc/simple-live-sync/simple-live-sync.env"
DB_FILE="/var/lib/simple-live-sync/metrics.sqlite"

install -d -m 0750 /etc/simple-live-sync /var/lib/simple-live-sync
touch "$ENV_FILE"
chmod 0600 "$ENV_FILE"

if ! grep -q '^IP_HASH_SECRET=' "$ENV_FILE"; then
  printf 'IP_HASH_SECRET=%s\n' "$(openssl rand -hex 32)" >>"$ENV_FILE"
fi
sed -i 's/^METRICS_ENABLED=.*/METRICS_ENABLED=true/' "$ENV_FILE"
if ! grep -q '^METRICS_ENABLED=' "$ENV_FILE"; then
  printf 'METRICS_ENABLED=true\n' >>"$ENV_FILE"
fi
if ! grep -q '^METRICS_DB_PATH=' "$ENV_FILE"; then
  printf 'METRICS_DB_PATH=%s\n' "$DB_FILE" >>"$ENV_FILE"
fi

systemctl daemon-reload
systemctl restart simple-live-sync.service

for attempt in {1..15}; do
  if curl --fail --silent --show-error http://127.0.0.1:8787/health?format=json >/dev/null; then
    break
  fi
  sleep 1
done

curl --fail --silent --show-error http://127.0.0.1:8787/health?format=json >/dev/null
stats="$(curl --fail --silent --show-error http://127.0.0.1:8787/api/stats/summary)"
printf '%s\n' "$stats" | grep -q '"totalCalls"'
test -s "$DB_FILE"
sqlite3 "$DB_FILE" 'PRAGMA quick_check;' | grep -Fxq ok
printf 'metrics enabled; database preserved at %s\n' "$DB_FILE"
printf '%s\n' "$stats"

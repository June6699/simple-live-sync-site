#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

DOMAIN="sync.furry.mo.cn"
EXPECTED_IP="186.241.120.176"

for command_name in docker nginx certbot curl getent systemctl; do
  command -v "$command_name" >/dev/null
done

docker compose version
nginx -t

resolved_ips="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u)"
if ! grep -Fxq "$EXPECTED_IP" <<<"$resolved_ips"; then
  printf 'Expected %s to resolve to %s, got:\n%s\n' "$DOMAIN" "$EXPECTED_IP" "$resolved_ips" >&2
  exit 1
fi

printf 'Preflight passed for %s -> %s\n' "$DOMAIN" "$EXPECTED_IP"

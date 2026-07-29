#!/usr/bin/env bash
set -euo pipefail
IFS=$'\n\t'

nginx -t
systemctl reload nginx

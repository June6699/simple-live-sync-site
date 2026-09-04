# Self-hosted deployment

The Node service runs from `/opt/simple-live-sync` and listens only on
`127.0.0.1:8787`. Nginx owns public HTTP, HTTPS, WebSocket traffic, trusted
client-IP headers, and GeoIP lookup for `sync.furry.mo.cn`. The Cloudflare
Worker is an independent deployment and does not share rooms or statistics.

## One-time host setup

Install the existing runtime dependencies plus SQLite backup, MaxMind update,
and the Nginx GeoIP2 module packages. Package names below are for Ubuntu:

```bash
apt-get update
apt-get install -y sqlite3 geoipupdate libnginx-mod-http-geoip2
install -d -m 0750 /etc/simple-live-sync
install -d -m 0755 /var/lib/GeoIP
install -d -m 0750 /var/lib/simple-live-sync
```

Copy `deploy/simple-live-sync.env.example` to
`/etc/simple-live-sync/simple-live-sync.env`, set mode `0600`, generate a
private `IP_HASH_SECRET` of at least 32 random characters, and only then set
`METRICS_ENABLED=true` (the default):

```bash
install -m 0600 deploy/simple-live-sync.env.example \
  /etc/simple-live-sync/simple-live-sync.env
openssl rand -hex 32
```

The generated value belongs only in the root-owned environment file. Do not
put it in Git, Compose, the systemd unit, logs, screenshots, or shell history.
The deploy scripts source this file for Compose; the systemd fallback reads the
same file through `EnvironmentFile=`. Changing `IP_HASH_SECRET` intentionally
breaks unique-visitor continuity, so rotate it only with a documented metrics
cutover.

The local `GeoIP.conf` contains MaxMind credentials and must also remain
untracked. Transfer it directly to `/etc/GeoIP.conf` with mode `0600`; do not
print or commit its contents. The repository's
`deploy/geoipupdate.conf.example` documents the required fields without real
credentials. Populate the database and install the daily updater:

```bash
chmod 0600 /etc/GeoIP.conf
geoipupdate -f /etc/GeoIP.conf -d /var/lib/GeoIP
test -r /var/lib/GeoIP/GeoLite2-City.mmdb
install -m 0644 deploy/simple-live-sync-geoipupdate.service \
  /etc/systemd/system/simple-live-sync-geoipupdate.service
install -m 0644 deploy/simple-live-sync-geoipupdate.timer \
  /etc/systemd/system/simple-live-sync-geoipupdate.timer
systemctl daemon-reload
systemctl enable --now simple-live-sync-geoipupdate.timer
systemctl start simple-live-sync-geoipupdate.service
```

The current `GeoLite2-City.mmdb` was obtained from the
[P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb) distribution of
MaxMind GeoLite2. Keep the MaxMind GeoLite2 EULA and CC BY-SA 4.0 attribution
with any manual database refresh; do not commit the binary database.

Nginx reads the City database with `auto_reload 1h`, so a normal GeoIP update
does not require an Nginx reload. The site overwrites `X-Real-IP`,
`X-Forwarded-For`, `X-Geo-Country`, and `X-Geo-Region`, and clears client-sent
`Forwarded`, `CF-Connecting-IP`, and `True-Client-IP`. The Node service must not
trust the left side of a client-provided forwarding chain.

## Configuration

Supported application settings in
`/etc/simple-live-sync/simple-live-sync.env` are:

| Variable | Production value | Purpose |
| --- | --- | --- |
| `PUBLIC_ORIGIN` | `https://sync.furry.mo.cn` | Public URL used by the Node server. |
| `METRICS_ENABLED` | `true` or `false` (default `true`) | Fail-open statistics switch. |
| `METRICS_DB_PATH` | `/var/lib/simple-live-sync/metrics.sqlite` | Host/systemd SQLite path. Compose maps the same state directory to `/app/data`. |
| `GEOIP_DB_PATH` | `/var/lib/GeoIP/GeoLite2-City.mmdb` | Host/systemd GeoIP database path. |
| `IP_HASH_SECRET` | private random value | Salt for anonymous visitor hashes; required when metrics are enabled. |

The Compose service sets `TRUST_PROXY_HEADERS=true` because port 8787 is
published on host loopback only and Nginx overwrites every forwarded location
header. Do not enable this setting when exposing the Node port directly or when
running behind an untrusted proxy.

Keep the database under `/var/lib/simple-live-sync`. Docker mounts this exact
directory at `/app/data`; the systemd unit creates it with `StateDirectory=`.
Both modes apply a restrictive umask. The deploy scripts change ownership only
inside this dedicated directory when switching runtime modes.

## Docker deployment

Update the checkout in `/opt/simple-live-sync`, then run:

```bash
cd /opt/simple-live-sync
bash deploy/0.1-preflight.sh
bash deploy/1.1-deploy.sh
bash deploy/2.1-verify.sh
```

The deploy script performs the production sequence in this order:

1. Validate DNS, Nginx, GeoIP, metrics configuration, and the current SQLite
   database.
2. Refuse to continue if the systemd fallback is still active.
3. Build static dashboard assets and the Node server before touching the
   running container.
4. Create a verified online SQLite backup when a database already exists.
5. Recreate the container with the Git commit as its image tag.
6. Check loopback health, validate and atomically reload Nginx, then run HTTP
   and WebSocket public smoke tests.

The container root filesystem remains read-only. Only
`/var/lib/simple-live-sync` is writable, and `/var/lib/GeoIP` is mounted
read-only. A container restart intentionally destroys active rooms but does
not remove statistics.

## Native Node fallback

When Docker Hub is unavailable but the server can reach npm, first stop the
Docker service, then use the systemd fallback:

```bash
cd /opt/simple-live-sync
docker compose stop sync
bash deploy/1.3-deploy-node.sh
bash deploy/2.4-verify-node.sh
```

The fallback runs `npm run build:web` before `npm run build:node`, backs up the
same SQLite database, installs the hardened unit, and explicitly restarts it.
The Docker and systemd modes cannot run at the same time because both own port
8787. To return to Docker, stop `simple-live-sync.service` before running the
Docker deploy script.

## Operations and monitoring

```bash
docker compose ps
docker compose logs --tail=100 sync
curl https://sync.furry.mo.cn/health?format=json
node deploy/2.6-http-smoke.mjs https://sync.furry.mo.cn --expect-metrics
node deploy/2.2-public-smoke.mjs wss://sync.furry.mo.cn/sync --ping-only
bash deploy/0.2-backup-metrics.sh
```

The HTTP smoke verifies the homepage, `status:true` health response, and,
when requested, `/api/stats`. Automated deployment and verification use the
WebSocket smoke's `--ping-only` mode, which does not create business-call
metrics. Running `2.2-public-smoke.mjs` without that flag verifies room creation,
room join, and all four synchronization actions, but records six real business
calls. `2.3-backend-isolation.mjs` records one room creation on each backend, so
both full checks are manual, explicit production diagnostics.

Container health checks show current process health but do not provide an
independent uptime record. For external availability evidence, run both the
HTTP and WebSocket probes from an off-host monitor at a fixed interval and keep
its region with the result. Missing scheduled observations must not be silently
treated as successful checks.

Application logs may contain service errors and lifecycle events, but must not
contain sync payloads, cookies, raw IP addresses, `IP_HASH_SECRET`, MaxMind
credentials, or environment-file contents.

## Backups and rollback

`deploy/0.2-backup-metrics.sh` uses SQLite's online backup command, validates
the copy with `PRAGMA quick_check`, and writes mode-`0600` files under
`/var/backups/simple-live-sync`. It never deletes old backups automatically.
Monitor disk usage and apply a separately reviewed retention policy.

For a code-only Docker rollback, leave the database and GeoIP directories in
place and start a previously built Git-tagged image:

```bash
set -a
source /etc/simple-live-sync/simple-live-sync.env
set +a
export SIMPLE_LIVE_SYNC_IMAGE_TAG=<previous-git-sha>
docker compose up -d --no-build sync
bash deploy/2.1-verify.sh
```

If that image is no longer present, check out the previous known-good commit,
run `deploy/1.1-deploy.sh`, and verify it. Schema changes must remain additive
so older code can ignore newer tables. Never use `docker compose down -v` or
delete `/var/lib/simple-live-sync` during a code rollback.

For the systemd fallback, check out the previous commit and rerun
`deploy/1.3-deploy-node.sh`. For a statistics-only incident, first set
`METRICS_ENABLED=false` and restart/redeploy; room synchronization and
`/health` must continue to work while statistics are disabled or degraded.

Restore SQLite only when data itself is corrupt, not for an ordinary code
rollback. Stop the active runtime, preserve the failed database and its
`-wal`/`-shm` files, install a verified backup as
`/var/lib/simple-live-sync/metrics.sqlite` with the owner required by the
selected runtime, then start and verify the service. Do not restore a database
while either runtime is writing to it.

Every Nginx candidate is tested before reload. Previous site files are kept in
`/var/backups/simple-live-sync/nginx`; to roll one back, install the chosen file
at `/etc/nginx/sites-available/sync.furry.mo.cn.conf`, run `nginx -t`, and only
then reload Nginx. Certificate renewal continues to validate Nginx before
reload through the installed Certbot deploy hook.

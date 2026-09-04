# Simple Live Sync Site

Shared WebSocket sync service for Simple Live. The same room protocol runs on:

- Node.js at `https://june6699.top` (the app default).
- Cloudflare Worker at `https://simple-live-sync.3439394104.workers.dev` (the backup needing proxy to connect).

The deployments are independent and do not share rooms or statistics. Every
device joining a room must select the same sync service, and each status page
reports only the traffic seen by that deployment.

## Routes

- `/` - service status, usage statistics, and diagnostics page.
- `/health` - JSON health endpoint.
- `/api/stats` - aggregate usage, geography, and availability JSON.
- `/assets/*` - locally served dashboard assets.
- `/sync` - WebSocket endpoint. Normal HTTP returns `websocket upgrade required`.

## Limits

- Room TTL: 600 seconds.
- Creator disconnect destroys the room.
- Max clients per room: 8.
- Max message size: 1 MB.
- Room data is held in memory and never persisted.
- Statistics use a separate persistent store and do not make room operations
  depend on SQLite or Durable Object storage health.
- Hourly, anonymous visitor, and hourly availability detail is retained for 90
  days. Daily aggregate history is retained.

## Statistics and privacy

Only six successful protocol actions are counted: room creation, room join,
favorite sync, history sync, shield-word sync, and Bilibili account sync.
Health checks, dashboard/API requests, rejected actions, and probe traffic are
not counted as business calls.

Statistics are enabled by default; set `METRICS_ENABLED=false` only when you
explicitly want to disable them. Raw IP addresses are never stored. The Node deployment accepts client location
only from Nginx-overwritten headers and hashes the address with a private salt
for short-lived unique-visitor calculation. Stored geography is limited to
country and first-level region codes. Set `METRICS_ENABLED=false` to disable
statistics without disabling the sync service.

Availability history starts when monitoring is first enabled. A settled hour
without a successful observation is shown as unavailable; time before the
recorded monitoring start is not backfilled as downtime.

## Development

```bash
npm install
npm run build:web
npm run typecheck
npm test
```

Run the Cloudflare Worker locally:

```bash
npm run dev:worker
```

Run the Node.js service locally:

```bash
npm run dev:node
```

Then open `http://127.0.0.1:8787/` or check
`http://127.0.0.1:8787/health`.

## Cloudflare deployment

```bash
npm run deploy
```

`wrangler.toml` keeps the Worker and Durable Object configuration. Cloudflare
Git integration may continue deploying the Worker from `master`.

## Self-hosted deployment

The production server uses Docker Compose in `/opt/simple-live-sync`, exposes
the container only on `127.0.0.1:8787`, and lets Nginx terminate TLS and proxy
WebSocket traffic. See `deploy/DEPLOYMENT.md` for deploy, verification, and
rollback commands, including SQLite backup, the private environment file, and
MaxMind GeoLite2 setup.

Production endpoints:

- `https://sync.furry.mo.cn/`
- `https://sync.furry.mo.cn/health`
- `wss://sync.furry.mo.cn/sync`

### GeoIP data source

The self-hosted Node deployment uses the `GeoLite2-City.mmdb` database for
country and first-level region lookup. The current database was downloaded on
2026-08-31 from the [P3TERX/GeoLite.mmdb](https://github.com/P3TERX/GeoLite.mmdb)
distribution of MaxMind GeoLite2
([GeoLite2-City.mmdb download](https://github.com/P3TERX/GeoLite.mmdb/raw/download/GeoLite2-City.mmdb))
and is installed at `/var/lib/GeoIP/GeoLite2-City.mmdb`.
The database and its contents remain subject to MaxMind's
[GeoLite2 End User License Agreement](https://www.maxmind.com/en/geolite2/eula)
and the [Creative Commons Attribution-ShareAlike 4.0 license](https://creativecommons.org/licenses/by-sa/4.0/).
The binary database is deployment state and must not be committed to this
repository.

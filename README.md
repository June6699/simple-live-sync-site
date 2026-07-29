# Simple Live Sync Site

Shared WebSocket sync service for Simple Live. The same room protocol runs on:

- Node.js at `https://sync.furry.mo.cn` (the app default).
- Cloudflare Worker at `https://simple-live-sync.3439394104.workers.dev` (the backup).

The deployments are independent and do not share rooms. Every device joining a
room must select the same sync service.

## Routes

- `/` - service status and diagnostics page.
- `/health` - JSON health endpoint.
- `/assets/app.js` - browser diagnostics.
- `/sync` - WebSocket endpoint. Normal HTTP returns `websocket upgrade required`.

## Limits

- Room TTL: 600 seconds.
- Creator disconnect destroys the room.
- Max clients per room: 8.
- Max message size: 1 MB.
- Room data is held in memory and never persisted.

## Development

```bash
npm install
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
rollback commands.

Production endpoints:

- `https://sync.furry.mo.cn/`
- `https://sync.furry.mo.cn/health`
- `wss://sync.furry.mo.cn/sync`

# Simple Live Sync Site

Cloudflare Worker for the Simple Live remote sync service and status page.

## Routes

- `/` - service status page with usage notes, diagnostics, release links, privacy notes, and self-hosting guidance.
- `/health` - JSON health endpoint.
- `/assets/app.js` - small browser diagnostics script.
- `/sync` - WebSocket endpoint used by Simple Live. Normal HTTP access returns `websocket upgrade required`.

## Limits

- Room TTL: 600 seconds.
- Creator disconnect destroys the room.
- Max clients per room: 8.
- Max message size: 1 MB.
- The Worker only relays temporary room data and does not persist follows, history, cookies, or shield words.

## Development

```bash
npm install
npm run typecheck
npm run dev
```

Local checks:

```bash
curl http://127.0.0.1:8787/health
```

Open `http://127.0.0.1:8787/` for the status page.

## Deploy

```bash
npm run deploy
```

After deploy, the public service is expected at:

- `https://simple-live-sync.3439394104.workers.dev/`
- `https://simple-live-sync.3439394104.workers.dev/health`
- `wss://simple-live-sync.3439394104.workers.dev/sync`

In Simple Live, custom self-hosted endpoints should use the WebSocket URL ending in `/sync`.

## GitHub Auto Deploy

This repository includes a GitHub Actions workflow that deploys the Worker on every push to `master`.

Required GitHub secrets:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

If you update the code locally and push to `master`, GitHub Actions will run `npm run typecheck` and then `npm run deploy`.

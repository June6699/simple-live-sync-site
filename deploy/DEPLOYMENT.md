# Self-hosted deployment

The Node service runs from `/opt/simple-live-sync` and listens through Docker on
`127.0.0.1:8787`. Nginx owns public HTTP, HTTPS, and WebSocket traffic for
`sync.furry.mo.cn`. The Cloudflare Worker remains a separate deployment and does
not share rooms with this server.

## Deploy

```bash
cd /opt/simple-live-sync
bash deploy/0.1-preflight.sh
bash deploy/1.1-deploy.sh
bash deploy/2.1-verify.sh
node deploy/2.2-public-smoke.mjs
node deploy/2.3-backend-isolation.mjs
```

## Operations

```bash
docker compose ps
docker compose logs --tail=100 sync
curl https://sync.furry.mo.cn/health
```

## Docker Hub fallback

When Docker Hub is unavailable but the server can reach npm, use the Node.js
systemd deployment instead:

```bash
cd /opt/simple-live-sync
bash deploy/1.3-deploy-node.sh
bash deploy/2.4-verify-node.sh
```

It uses the same source, `127.0.0.1:8787` listener, Nginx site, TLS, and
verification scripts as the Docker deployment.

Rooms are memory-only. Restarting the container intentionally destroys all
active rooms. Logs contain service errors and lifecycle events only, never sync
payloads or account cookies. `certbot.timer` renews the certificate and the
installed deploy hook validates and reloads Nginx afterward.

## Rollback

Stop the container with `docker compose down`, remove the
`/etc/nginx/sites-enabled/sync.furry.mo.cn.conf` symlink, validate with
`nginx -t`, and reload Nginx. This rollback does not affect the existing
`furry.mo.cn` site or the Cloudflare Worker.

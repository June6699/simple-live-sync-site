import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";

import {
  buildHealthPayload,
  DEFAULT_SERVICE_ORIGIN,
  MAX_MESSAGE_BYTES,
  renderAppScript,
  renderHealthPage,
  renderHomePage,
  RoomHubCore
} from "./index.js";
import { createFailOpenMetricsSink, normalizeCountryCode, normalizeRegionCode, type ConnectionContext } from "./metrics.js";
import { NodeMetricsService } from "./metrics-node.js";
import { isStatsApiPath, queryStatsApi, STATS_CACHE_CONTROL } from "./stats-api.js";

export type SyncServerOptions = {
  host?: string;
  port?: number;
  publicOrigin?: string;
  metricsEnabled?: boolean;
  metricsDbPath?: string;
  ipHashSecret?: string;
  trustProxyHeaders?: boolean;
  publicDirectory?: string;
  metricsService?: NodeMetricsService;
};

export type SyncServerRuntime = {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
};

export function createSyncServer(options: SyncServerOptions = {}): SyncServerRuntime {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const publicOrigin = normalizeOrigin(options.publicOrigin ?? DEFAULT_SERVICE_ORIGIN);
  const metricsEnabled = options.metricsEnabled ??
    (options.metricsService !== undefined || process.env.METRICS_ENABLED === "true");
  let metricsService: NodeMetricsService | undefined;
  if (metricsEnabled) {
    if (options.metricsService) {
      metricsService = options.metricsService;
    } else {
      try {
        metricsService = new NodeMetricsService({
          path: options.metricsDbPath ?? process.env.METRICS_DB_PATH ?? "/var/lib/simple-live-sync/metrics.sqlite",
          onError: (error) => console.error("Metrics write failed", safeError(error))
        });
      } catch (error) {
        console.error("Metrics initialization failed", safeError(error));
      }
    }
  }
  const metricsSink = metricsService ? createFailOpenMetricsSink(metricsService) : undefined;
  const publicDirectory = resolve(options.publicDirectory ?? join(process.cwd(), "public"));
  const ipHashSecret = options.ipHashSecret ?? process.env.IP_HASH_SECRET ?? "";
  const trustProxyHeaders = options.trustProxyHeaders ?? process.env.TRUST_PROXY_HEADERS === "true";
  let probeTimer: ReturnType<typeof setTimeout> | undefined;
  let probesStopped = false;
  const scheduleAvailabilityProbe = () => {
    if (!metricsService || probesStopped) {
      return;
    }
    probeTimer = scheduleNodeAvailabilityProbe(
      metricsService,
      publicOrigin,
      scheduleAvailabilityProbe
    );
  };
  const hub = new RoomHubCore({ metricsSink });
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES * 2,
    perMessageDeflate: false
  });

  const httpServer = createServer((request, response) => {
    handleHttpRequest(request, response, publicOrigin, publicDirectory, metricsService, metricsEnabled);
  });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", publicOrigin);
    if (url.pathname !== "/sync") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
      webSocketServer.emit("connection", webSocket, request);
    });
  });

  webSocketServer.on("connection", (webSocket, request) => {
    const socket = webSocket as unknown as WebSocket;
    hub.attachSocket(
      socket,
      false,
      resolveNodeConnectionContext(request, ipHashSecret, trustProxyHeaders)
    );
    webSocket.on("message", (data, isBinary) => {
      const raw = isBinary ? data : data.toString("utf8");
      hub.handleSocketMessage(socket, raw).catch((error) => {
        console.error("WebSocket message handling failed", safeError(error));
      });
    });
    webSocket.on("close", () => hub.removeSocket(socket));
    webSocket.on("error", () => hub.removeSocket(socket));
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        httpServer.once("error", onError);
        httpServer.listen(port, host, () => {
          httpServer.off("error", onError);
          const address = httpServer.address();
          if (!address || typeof address === "string") {
            reject(new Error("server did not expose a TCP address"));
            return;
          }
          if (metricsService) {
            probesStopped = false;
            scheduleAvailabilityProbe();
          }
          resolve({ host, port: address.port });
        });
      });
    },
    async stop() {
      probesStopped = true;
      if (probeTimer) {
        clearTimeout(probeTimer);
        probeTimer = undefined;
      }
      hub.dispose();
      for (const client of webSocketServer.clients) {
        if (client.readyState === NodeWebSocket.OPEN) {
          client.close(1001, "server shutdown");
        }
      }
      await Promise.all([
        new Promise<void>((resolve) => webSocketServer.close(() => resolve())),
        new Promise<void>((resolve, reject) => {
          httpServer.close((error) => (error ? reject(error) : resolve()));
        })
      ]);
      metricsService?.close();
    }
  };
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  publicOrigin: string,
  publicDirectory: string,
  metricsService: NodeMetricsService | undefined,
  metricsEnabled: boolean
): void {
  const url = new URL(request.url ?? "/", publicOrigin);
  if (url.pathname === "/") {
    sendText(response, 200, "text/html; charset=utf-8", renderHomePage(publicOrigin), true);
    return;
  }
  if (url.pathname === "/assets/app.js") {
    sendText(
      response,
      200,
      "application/javascript; charset=utf-8",
      renderAppScript(),
      true
    );
    return;
  }
  if (url.pathname === "/stats" || url.pathname === "/stats/") {
    sendStaticFile(response, publicDirectory, "stats.html", "text/html; charset=utf-8");
    return;
  }
  if (url.pathname === "/stats.html") {
    sendStaticFile(response, publicDirectory, "stats.html", "text/html; charset=utf-8");
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    const relative = url.pathname.slice("/assets/".length);
    if (!isSafeStaticPath(relative)) {
      sendJson(response, 404, { status: false, message: "not found" });
      return;
    }
    const contentType = contentTypeFor(relative);
    if (!contentType) {
      sendJson(response, 404, { status: false, message: "not found" });
      return;
    }
    sendStaticFile(response, join(publicDirectory, "assets"), relative, contentType);
    return;
  }
  if (url.pathname === "/health") {
    const acceptsHtml = request.headers.accept?.includes("text/html") === true;
    const wantsHtml =
      url.searchParams.get("format") === "html" ||
      (url.searchParams.get("format") !== "json" && acceptsHtml);
    if (wantsHtml) {
      sendText(
        response,
        200,
        "text/html; charset=utf-8",
        renderHealthPage(publicOrigin),
        false
      );
      return;
    }
    sendJson(response, 200, buildHealthPayload());
    return;
  }
  if (isStatsApiPath(url.pathname)) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      sendJson(response, 405, { status: false, message: "method not allowed" });
      return;
    }
    if (!metricsEnabled || !metricsService) {
      sendJson(response, 503, { status: false, message: "statistics are temporarily unavailable" });
      return;
    }
    try {
      const result = queryStatsApi(metricsService.store, url, publicOrigin);
      sendJson(response, result.status, result.payload, result.status === 200 ? STATS_CACHE_CONTROL : "no-store");
    } catch (error) {
      console.error("Stats API failed", safeError(error));
      sendJson(response, 503, { status: false, message: "statistics are temporarily unavailable" });
    }
    return;
  }
  if (url.pathname === "/sync") {
    sendJson(response, 426, { status: false, message: "websocket upgrade required" });
    return;
  }
  sendJson(response, 404, { status: false, message: "not found" });
}

function sendText(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
  cacheControl: boolean | string
): void {
  const resolvedCacheControl = typeof cacheControl === "string"
    ? cacheControl
    : cacheControl
      ? "public, max-age=120"
      : "no-store";
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": resolvedCacheControl,
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown, cacheControl = "no-store"): void {
  sendText(
    response,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(payload),
    cacheControl
  );
}

function normalizeOrigin(value: string): string {
  const origin = value.trim().replace(/\/+$/, "");
  const parsed = new URL(origin);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use http or https");
  }
  return parsed.origin;
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resolveNodeConnectionContext(
  request: IncomingMessage,
  ipHashSecret: string,
  trustProxyHeaders = false
): ConnectionContext {
  const remoteAddress = normalizeIp(request.socket.remoteAddress);
  if (!remoteAddress || (!isLoopbackAddress(remoteAddress) && !trustProxyHeaders)) {
    return { source: "node", countryCode: "ZZ", regionCode: "", isProbe: false };
  }
  const ip = normalizeIp(request.headers["x-real-ip"]?.toString());
  const countryCode = normalizeCountryCode(request.headers["x-geo-country"]);
  const regionCode = normalizeRegionCode(request.headers["x-geo-region"]);
  return {
    source: "node",
    countryCode,
    regionCode,
    visitorHash: ip && ipHashSecret ? createHmac("sha256", ipHashSecret).update(ip).digest("hex") : undefined,
    isProbe: false
  };
}

function normalizeIp(value: string | undefined): string | undefined {
  const normalized = value?.trim().replace(/^\[|\]$/g, "");
  if (!normalized || normalized.includes(",") || normalized.includes(" ")) {
    return undefined;
  }
  if (normalized.startsWith("::ffff:")) {
    return normalized.slice(7);
  }
  return normalized;
}

function isLoopbackAddress(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address.startsWith("127.");
}

function isSafeStaticPath(relativePath: string): boolean {
  if (!relativePath || relativePath.includes("\\") || relativePath.includes("\0")) {
    return false;
  }
  const parts = relativePath.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

function contentTypeFor(relativePath: string): string | undefined {
  const extension = relativePath.toLowerCase().slice(relativePath.lastIndexOf("."));
  return {
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".geojson": "application/geo+json; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
    ".map": "application/json; charset=utf-8"
  }[extension];
}

function sendStaticFile(
  response: ServerResponse,
  rootDirectory: string,
  relativePath: string,
  contentType: string
): void {
  const filePath = resolve(rootDirectory, relativePath);
  const root = resolve(rootDirectory);
  if (!filePath.startsWith(`${root}${process.platform === "win32" ? "\\" : "/"}`) || !existsSync(filePath)) {
    sendJson(response, 404, { status: false, message: "not found" });
    return;
  }
  try {
    const body = readFileSync(filePath);
    response.writeHead(200, {
      "content-type": contentType,
      "cache-control": relativePath.endsWith(".html") ? "public, max-age=120" : "public, max-age=300",
      "content-length": body.byteLength
    });
    response.end(body);
  } catch {
    sendJson(response, 404, { status: false, message: "not found" });
  }
}

function scheduleNodeAvailabilityProbe(
  metricsService: NodeMetricsService,
  publicOrigin: string,
  scheduleNext: () => void
): ReturnType<typeof setTimeout> {
  const now = new Date();
  const next = new Date(now);
  next.setUTCMinutes(5, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  const timer = setTimeout(async () => {
    try {
      const event = await runNodeAvailabilityProbe(publicOrigin);
      metricsService.record(event, { source: "node", countryCode: "ZZ", regionCode: "", isProbe: true }, Date.now());
    } catch (error) {
      console.error("Node availability probe failed", safeError(error));
    }
    scheduleNext();
  }, Math.max(1, next.getTime() - now.getTime()));
  timer.unref?.();
  return timer;
}

async function runNodeAvailabilityProbe(publicOrigin: string) {
  const startedAt = Date.now();
  let httpOk = false;
  let websocketOk = false;
  let httpLatencyMs: number | undefined;
  let websocketLatencyMs: number | undefined;
  let errorCode = "";
  try {
    const response = await fetch(`${publicOrigin}/health?format=json`, { signal: AbortSignal.timeout(10_000) });
    const body = (await response.json()) as { status?: unknown };
    httpOk = response.ok && body.status === true;
    httpLatencyMs = Date.now() - startedAt;
    if (!httpOk) errorCode += `http:${response.status};`;
  } catch (error) {
    errorCode += `http:${safeError(error).slice(0, 40)};`;
  }
  try {
    const { WebSocket } = await import("ws");
    websocketOk = await new Promise<boolean>((resolve) => {
      const socket = new WebSocket(publicOrigin.replace(/^http/, "ws") + "/sync");
      const requestId = `availability-${Date.now()}`;
      const timer = setTimeout(() => { socket.terminate(); resolve(false); }, 10_000);
      const started = Date.now();
      socket.once("open", () => socket.send(JSON.stringify({ type: "ping", requestId })));
      socket.once("message", (data) => {
        clearTimeout(timer);
        try {
          const payload = JSON.parse(data.toString("utf8"));
          websocketOk = payload.type === "pong" && payload.requestId === requestId;
          websocketLatencyMs = Date.now() - started;
        } catch {
          websocketOk = false;
        }
        socket.close();
        resolve(websocketOk);
      });
      socket.once("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (!websocketOk) errorCode += "ws:failed;";
  } catch (error) {
    errorCode += `ws:${safeError(error).slice(0, 40)};`;
  }
  return {
    type: "availability_check" as const,
    target: publicOrigin,
    httpOk,
    websocketOk,
    httpLatencyMs,
    websocketLatencyMs,
    errorCode: errorCode.slice(0, 80) || undefined
  };
}

function readPort(value: string | undefined): number {
  const port = Number.parseInt(value ?? "8787", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const runtime = createSyncServer({
    host: process.env.HOST ?? "127.0.0.1",
    port: readPort(process.env.PORT),
    publicOrigin: process.env.PUBLIC_ORIGIN ?? DEFAULT_SERVICE_ORIGIN
  });
  const address = await runtime.start();
  console.log(`Simple Live Sync listening on ${address.host}:${address.port}`);

  let stopping = false;
  const stop = async () => {
    if (stopping) {
      return;
    }
    stopping = true;
    await runtime.stop();
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

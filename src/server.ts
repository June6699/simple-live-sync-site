import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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

export type SyncServerOptions = {
  host?: string;
  port?: number;
  publicOrigin?: string;
};

export type SyncServerRuntime = {
  start(): Promise<{ host: string; port: number }>;
  stop(): Promise<void>;
};

export function createSyncServer(options: SyncServerOptions = {}): SyncServerRuntime {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 8787;
  const publicOrigin = normalizeOrigin(options.publicOrigin ?? DEFAULT_SERVICE_ORIGIN);
  const hub = new RoomHubCore();
  const webSocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES * 2,
    perMessageDeflate: false
  });

  const httpServer = createServer((request, response) => {
    handleHttpRequest(request, response, publicOrigin);
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

  webSocketServer.on("connection", (webSocket) => {
    const socket = webSocket as unknown as WebSocket;
    hub.attachSocket(socket, false);
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
          resolve({ host, port: address.port });
        });
      });
    },
    async stop() {
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
    }
  };
}

function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  publicOrigin: string
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
  cacheable: boolean
): void {
  response.writeHead(status, {
    "content-type": contentType,
    "cache-control": cacheable ? "public, max-age=120" : "no-store",
    "content-length": Buffer.byteLength(body)
  });
  response.end(body);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  sendText(
    response,
    status,
    "application/json; charset=utf-8",
    JSON.stringify(payload),
    false
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

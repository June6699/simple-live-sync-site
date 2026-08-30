import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket, { type RawData } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_MESSAGE_BYTES } from "../src/index.js";
import { NodeMetricsService } from "../src/metrics-node.js";
import {
  createSyncServer,
  resolveNodeConnectionContext,
  type SyncServerRuntime
} from "../src/server.js";

let runtime: SyncServerRuntime | undefined;
let metricsDirectory: string | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  vi.restoreAllMocks();
  if (metricsDirectory) {
    rmSync(metricsDirectory, { recursive: true, force: true });
    metricsDirectory = undefined;
  }
});

describe("Node sync server", () => {
  it("only accepts forwarded visitor headers from an explicitly trusted proxy", () => {
    const request = {
      socket: { remoteAddress: "172.18.0.1" },
      headers: {
        "x-real-ip": "203.0.113.10",
        "x-geo-country": "DE",
        "x-geo-region": "BE"
      }
    } as never;

    expect(resolveNodeConnectionContext(request, "test-secret", false)).toEqual({
      source: "node",
      countryCode: "ZZ",
      regionCode: "",
      isProbe: false
    });
    expect(resolveNodeConnectionContext(request, "test-secret", true)).toMatchObject({
      source: "node",
      countryCode: "DE",
      regionCode: "BE",
      visitorHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      isProbe: false
    });
  });

  it("serves health, rejects normal HTTP on /sync, and accepts WebSocket ping", async () => {
    runtime = createSyncServer({
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "http://127.0.0.1"
    });
    const address = await runtime.start();
    const origin = `http://127.0.0.1:${address.port}`;

    const health = await fetch(`${origin}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ status: true, endpoints: { sync: "/sync" } });

    const normalSync = await fetch(`${origin}/sync`);
    expect(normalSync.status).toBe(426);

    const response = await websocketRequest(`ws://127.0.0.1:${address.port}/sync`, {
      type: "ping",
      requestId: "node-ping"
    });
    expect(response).toMatchObject({ type: "pong", requestId: "node-ping" });

    const oversized = await websocketRequest(
      `ws://127.0.0.1:${address.port}/sync`,
      "x".repeat(MAX_MESSAGE_BYTES + 1),
      "error"
    );
    expect(oversized.error).toMatchObject({ code: "payloadTooLarge" });
  });

  it("serves stats assets and records successful business calls", async () => {
    metricsDirectory = mkdtempSync(join(tmpdir(), "simple-live-sync-server-test-"));
    const metricsService = new NodeMetricsService({
      path: join(metricsDirectory, "metrics.sqlite"),
      maxBatchSize: 1
    });
    runtime = createSyncServer({
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "http://127.0.0.1",
      metricsService,
      ipHashSecret: "server-test-secret-which-is-long-enough-123"
    });
    const address = await runtime.start();
    const origin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${origin}/stats`)).status).toBe(200);
    expect((await fetch(`${origin}/assets/maps/china-adm1.geojson`)).status).toBe(200);
    const methodNotAllowed = await fetch(`${origin}/api/stats/summary`, {
      method: "POST"
    });
    expect(methodNotAllowed.status).toBe(405);
    expect(methodNotAllowed.headers.get("allow")).toBe("GET, HEAD");
    expect(methodNotAllowed.headers.get("cache-control")).toBe("no-store");
    const summaryBefore = await (await fetch(`${origin}/api/stats/summary`)).json() as { totalCalls: number };
    expect(summaryBefore.totalCalls).toBe(0);

    const syncUrl = `ws://127.0.0.1:${address.port}/sync`;
    const creator = await openWebSocket(syncUrl);
    const joiner = await openWebSocket(syncUrl);
    try {
      const created = await websocketRequestOnSocket(
        creator,
        { type: "createRoom", payload: { app: "test", platform: "node", version: "1" } },
        "roomCreated"
      );
      await websocketRequestOnSocket(
        joiner,
        { type: "joinRoom", roomId: String(created.roomId), payload: { app: "test", platform: "node", version: "1" } },
        "roomJoined"
      );
    } finally {
      creator.close();
      joiner.close();
    }
    const summaryAfter = await waitForTotalCalls(origin, 2);
    expect(summaryAfter.totalCalls).toBe(2);
  });

  it("keeps sync available when metrics initialization fails", async () => {
    metricsDirectory = mkdtempSync(join(tmpdir(), "simple-live-sync-invalid-metrics-"));
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    runtime = createSyncServer({
      host: "127.0.0.1",
      port: 0,
      publicOrigin: "http://127.0.0.1",
      metricsEnabled: true,
      metricsDbPath: metricsDirectory
    });
    const address = await runtime.start();
    const origin = `http://127.0.0.1:${address.port}`;

    expect((await fetch(`${origin}/health`)).status).toBe(200);
    const stats = await fetch(`${origin}/api/stats/summary`);
    expect(stats.status).toBe(503);
    expect(stats.headers.get("cache-control")).toBe("no-store");
    expect(error).toHaveBeenCalledWith(
      "Metrics initialization failed",
      expect.any(String)
    );
  });

  it("does not use an injected metrics service when statistics are disabled", async () => {
    const metricsService = new NodeMetricsService({ path: ":memory:", maxBatchSize: 1 });
    try {
      runtime = createSyncServer({
        host: "127.0.0.1",
        port: 0,
        publicOrigin: "http://127.0.0.1",
        metricsEnabled: false,
        metricsService
      });
      const address = await runtime.start();
      const origin = `http://127.0.0.1:${address.port}`;
      await websocketRequest(`ws://127.0.0.1:${address.port}/sync`, {
        type: "createRoom",
        payload: { app: "test", platform: "node", version: "1" }
      }, "roomCreated");

      expect(metricsService.store.queryTotals()).toHaveLength(0);
      const stats = await fetch(`${origin}/api/stats/summary`);
      expect(stats.status).toBe(503);
      expect(stats.headers.get("cache-control")).toBe("no-store");
    } finally {
      await runtime?.stop();
      runtime = undefined;
      metricsService.close();
    }
  });
});

async function waitForTotalCalls(origin: string, expectedTotal: number): Promise<{ totalCalls: number }> {
  const deadline = Date.now() + 1_000;
  let summary = { totalCalls: 0 };
  while (Date.now() < deadline) {
    summary = await (await fetch(`${origin}/api/stats/summary`)).json() as { totalCalls: number };
    if (summary.totalCalls === expectedTotal) {
      return summary;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return summary;
}

function websocketRequest(
  url: string,
  request: unknown,
  expectedType = "pong"
): Promise<Record<string, unknown>> {
  return openWebSocket(url).then(async (socket) => {
    try {
      return await websocketRequestOnSocket(socket, request, expectedType);
    } finally {
      socket.close();
    }
  });
}

function openWebSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket open timed out"));
    }, 3_000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function websocketRequestOnSocket(
  socket: WebSocket,
  request: unknown,
  expectedType = "pong"
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("WebSocket response timed out"));
    }, 3_000);
    const onMessage = (data: RawData) => {
      const payload = JSON.parse(data.toString("utf8")) as Record<string, unknown>;
      if (payload.type !== expectedType) {
        if (payload.type === "error" && expectedType !== "error") {
          cleanup();
          reject(new Error(`WebSocket error response: ${JSON.stringify(payload.error)}`));
        }
        return;
      }
      cleanup();
      resolve(payload);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("message", onMessage);
      socket.off("error", onError);
    };
    socket.on("message", onMessage);
    socket.once("error", onError);
    socket.send(typeof request === "string" ? request : JSON.stringify(request));
  });
}

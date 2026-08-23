import { afterEach, describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_MESSAGE_BYTES } from "../src/index.js";
import { NodeMetricsService } from "../src/metrics-node.js";
import { createSyncServer, type SyncServerRuntime } from "../src/server.js";

let runtime: SyncServerRuntime | undefined;
let metricsDirectory: string | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  if (metricsDirectory) {
    rmSync(metricsDirectory, { recursive: true, force: true });
    metricsDirectory = undefined;
  }
});

describe("Node sync server", () => {
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
      metricsEnabled: true,
      metricsService,
      ipHashSecret: "server-test-secret-which-is-long-enough-123"
    });
    const address = await runtime.start();
    const origin = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${origin}/stats`)).status).toBe(200);
    expect((await fetch(`${origin}/assets/stats.js`)).status).toBe(200);
    expect((await fetch(`${origin}/assets/maps/china-adm1.geojson`)).status).toBe(200);
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

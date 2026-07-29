import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { MAX_MESSAGE_BYTES } from "../src/index.js";
import { createSyncServer, type SyncServerRuntime } from "../src/server.js";

let runtime: SyncServerRuntime | undefined;

afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
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
      "x".repeat(MAX_MESSAGE_BYTES + 1)
    );
    expect(oversized.error).toMatchObject({ code: "payloadTooLarge" });
  });
});

function websocketRequest(
  url: string,
  request: unknown
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket response timed out"));
    }, 3_000);
    socket.once("open", () =>
      socket.send(typeof request === "string" ? request : JSON.stringify(request))
    );
    socket.once("message", (data) => {
      clearTimeout(timer);
      socket.close();
      resolve(JSON.parse(data.toString("utf8")) as Record<string, unknown>);
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

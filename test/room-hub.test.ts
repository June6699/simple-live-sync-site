import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_MESSAGE_BYTES,
  MAX_ROOM_CLIENTS,
  RoomHubCore
} from "../src/index.js";
import type { ConnectionContext, MetricsEvent } from "../src/metrics.js";

class FakeSocket {
  readonly messages: Array<Record<string, unknown>> = [];
  closed?: { code?: number; reason?: string };

  send(value: string): void {
    this.messages.push(JSON.parse(value) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
}

const hubs: RoomHubCore[] = [];

afterEach(() => {
  for (const hub of hubs) {
    hub.dispose();
  }
  hubs.length = 0;
  vi.useRealTimers();
});

function createHub(options: ConstructorParameters<typeof RoomHubCore>[0] = {}): RoomHubCore {
  const hub = new RoomHubCore(options);
  hubs.push(hub);
  return hub;
}

function attach(hub: RoomHubCore, context: ConnectionContext = {}): FakeSocket {
  const socket = new FakeSocket();
  hub.attachSocket(socket as unknown as WebSocket, false, context);
  return socket;
}

async function send(
  hub: RoomHubCore,
  socket: FakeSocket,
  message: Record<string, unknown> | string
): Promise<void> {
  const raw = typeof message === "string" ? message : JSON.stringify(message);
  await hub.handleSocketMessage(socket as unknown as WebSocket, raw);
}

function latest(socket: FakeSocket, type: string): Record<string, unknown> | undefined {
  return [...socket.messages].reverse().find((message) => message.type === type);
}

function clientInfo(app = "Simple Live"): Record<string, string> {
  return { app, platform: "test", version: "1.0.0" };
}

describe("RoomHubCore", () => {
  it("responds to ping", async () => {
    const hub = createHub();
    const socket = attach(hub);
    await send(hub, socket, { type: "ping", requestId: "ping-1" });
    expect(latest(socket, "pong")).toMatchObject({ type: "pong", requestId: "ping-1" });
  });

  it("creates, joins, and forwards every supported payload", async () => {
    const hub = createHub();
    const creator = attach(hub);
    const joiner = attach(hub);
    await send(hub, creator, { type: "createRoom", requestId: "create", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;
    expect(roomId).toMatch(/^[A-Z2-9]{6}$/);

    await send(hub, joiner, {
      type: "joinRoom",
      requestId: "join",
      roomId,
      payload: clientInfo("Simple Live TV")
    });
    expect(latest(joiner, "roomJoined")).toMatchObject({ roomId });
    expect((latest(creator, "userUpdated")?.users as unknown[]).length).toBe(2);

    const actions = [
      ["sendFavorite", "favoriteReceived"],
      ["sendHistory", "historyReceived"],
      ["sendShieldWord", "shieldWordReceived"],
      ["sendBiliAccount", "biliAccountReceived"]
    ] as const;
    for (const [action, event] of actions) {
      await send(hub, creator, {
        type: action,
        requestId: action,
        roomId,
        payload: { overlay: true, content: `["${action}"]` }
      });
      expect(latest(joiner, event)).toMatchObject({
        roomId,
        payload: { overlay: true, content: `["${action}"]` }
      });
      expect(latest(creator, "ack")).toMatchObject({ requestId: action, action, roomId });
    }
  });

  it("rejects invalid JSON, oversized payloads, and full rooms", async () => {
    const hub = createHub();
    const creator = attach(hub);
    await send(hub, creator, "not-json");
    expect(latest(creator, "error")?.error).toMatchObject({ code: "invalidJson" });
    await send(hub, creator, "null");
    expect(latest(creator, "error")?.error).toMatchObject({ code: "invalidMessage" });
    await send(hub, creator, "x".repeat(MAX_MESSAGE_BYTES + 1));
    expect(latest(creator, "error")?.error).toMatchObject({ code: "payloadTooLarge" });

    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;
    for (let index = 1; index < MAX_ROOM_CLIENTS; index++) {
      const joiner = attach(hub);
      await send(hub, joiner, { type: "joinRoom", roomId, payload: clientInfo() });
      expect(latest(joiner, "roomJoined")).toBeDefined();
    }
    const extra = attach(hub);
    await send(hub, extra, { type: "joinRoom", roomId, payload: clientInfo() });
    expect(latest(extra, "error")?.error).toMatchObject({ code: "roomFull" });
  });

  it("destroys the room when the creator disconnects", async () => {
    const hub = createHub();
    const creator = attach(hub);
    const joiner = attach(hub);
    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;
    await send(hub, joiner, { type: "joinRoom", roomId, payload: clientInfo() });
    hub.removeSocket(creator as unknown as WebSocket);
    expect(latest(joiner, "roomDestroyed")).toMatchObject({
      roomId,
      reason: "creatorDisconnected"
    });
  });

  it("preserves live connection context when clients leave or their room is destroyed", async () => {
    const metrics: Array<{ event: MetricsEvent; context?: ConnectionContext }> = [];
    const hub = createHub({
      metricsSink: {
        record(event, context) {
          metrics.push({ event, context });
        }
      }
    });
    const creatorContext = {
      source: "node" as const,
      visitorHash: "creator-hash",
      countryCode: "CN",
      regionCode: "BJ"
    };
    const joinerContext = {
      source: "node" as const,
      visitorHash: "joiner-hash",
      countryCode: "US",
      regionCode: ""
    };
    const creator = attach(hub, creatorContext);
    const joiner = attach(hub, joinerContext);

    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const firstRoomId = latest(creator, "roomCreated")?.roomId as string;
    await send(hub, joiner, {
      type: "joinRoom",
      roomId: firstRoomId,
      payload: clientInfo("Simple Live TV")
    });
    await send(hub, creator, { type: "leaveRoom" });
    expect(latest(joiner, "roomDestroyed")).toMatchObject({
      roomId: firstRoomId,
      reason: "creatorDisconnected"
    });

    await send(hub, joiner, { type: "createRoom", payload: clientInfo("Simple Live TV") });
    const secondRoomId = latest(joiner, "roomCreated")?.roomId as string;
    await send(hub, creator, {
      type: "joinRoom",
      roomId: secondRoomId,
      payload: clientInfo()
    });

    expect(metrics.map(({ context }) => context)).toEqual([
      creatorContext,
      joinerContext,
      joinerContext,
      creatorContext
    ]);
  });

  it("keeps detached live sockets under heartbeat supervision", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const hub = createHub({ heartbeatTimeoutMs: 100, sweepIntervalMs: 10 });
    const creator = attach(hub);
    const joiner = attach(hub);
    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;
    await send(hub, joiner, { type: "joinRoom", roomId, payload: clientInfo() });

    await send(hub, creator, { type: "leaveRoom" });
    await vi.advanceTimersByTimeAsync(110);

    expect(creator.closed).toMatchObject({ code: 1001, reason: "heartbeat timeout" });
    expect(joiner.closed).toMatchObject({ code: 1001, reason: "heartbeat timeout" });
  });

  it("treats joining the current room as an idempotent retry", async () => {
    const metricTypes: string[] = [];
    const hub = createHub({
      metricsSink: {
        record(event) {
          metricTypes.push(event.type);
        }
      }
    });
    const creator = attach(hub);
    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;

    await send(hub, creator, {
      type: "joinRoom",
      requestId: "retry-join",
      roomId,
      payload: clientInfo()
    });
    expect(latest(creator, "roomJoined")).toMatchObject({
      requestId: "retry-join",
      roomId,
      user: { isCreator: true }
    });
    expect(latest(creator, "roomJoined")?.expiresIn).toEqual(expect.any(Number));

    await send(hub, creator, {
      type: "sendHistory",
      requestId: "after-retry",
      roomId,
      payload: { overlay: false, content: "[]" }
    });
    expect(latest(creator, "ack")).toMatchObject({
      requestId: "after-retry",
      roomId
    });
    expect(metricTypes).toEqual(["room_created", "send_history"]);
  });

  it("expires rooms after their TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const hub = createHub({ roomTtlMs: 100, sweepIntervalMs: 10 });
    const creator = attach(hub);
    await send(hub, creator, { type: "createRoom", payload: clientInfo() });
    const roomId = latest(creator, "roomCreated")?.roomId as string;
    vi.setSystemTime(new Date("2026-01-01T00:00:00.110Z"));
    const joiner = attach(hub);
    await send(hub, joiner, { type: "joinRoom", roomId, payload: clientInfo() });
    expect(latest(creator, "roomDestroyed")).toMatchObject({ reason: "expired" });
    expect(latest(joiner, "error")?.error).toMatchObject({ code: "roomExpired" });
  });
});

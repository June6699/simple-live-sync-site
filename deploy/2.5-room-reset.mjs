import { writeFile } from "node:fs/promises";

import WebSocket from "ws";

const [mode, endpoint = "wss://sync.furry.mo.cn/sync", value] = process.argv.slice(2);
const timeoutMs = 8_000;

if (mode === "create") {
  await createRoom(endpoint, value);
} else if (mode === "expect-missing") {
  await expectMissingRoom(endpoint, value);
} else {
  throw new Error("usage: create <endpoint> <room-id-file> | expect-missing <endpoint> <room-id>");
}

async function createRoom(url, roomIdFile) {
  if (!roomIdFile) {
    throw new Error("room id file is required");
  }
  const socket = await connect(url);
  const created = waitFor(socket, (message) => message.type === "roomCreated");
  socket.send(
    JSON.stringify({
      type: "createRoom",
      requestId: "restart-check-create",
      payload: {
        app: "Simple Live Restart Check",
        platform: "node",
        version: "1.0.0"
      }
    })
  );
  const roomId = String((await created).roomId ?? "");
  assert(/^[A-Z2-9]{6}$/.test(roomId), "room creation failed");
  await writeFile(roomIdFile, `${roomId}\n`, "utf8");
  console.log(roomId);

  await Promise.race([
    new Promise((resolve) => setTimeout(resolve, 120_000)),
    new Promise((resolve) => socket.once("close", resolve))
  ]);
  socket.close(1000, "restart check complete");
}

async function expectMissingRoom(url, roomId) {
  if (!roomId) {
    throw new Error("room id is required");
  }
  const socket = await connect(url);
  const rejected = waitFor(
    socket,
    (message) => message.type === "error" && message.requestId === "restart-check-join"
  );
  socket.send(
    JSON.stringify({
      type: "joinRoom",
      requestId: "restart-check-join",
      roomId,
      payload: {
        app: "Simple Live Restart Check",
        platform: "node",
        version: "1.0.0"
      }
    })
  );
  const response = await rejected;
  assert(response.error?.code === "roomNotFound", `expected roomNotFound: ${JSON.stringify(response)}`);
  socket.close(1000, "restart check complete");
  console.log(`Room reset check passed for ${roomId}`);
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`connection timed out: ${url}`));
    }, timeoutMs);
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

function waitFor(socket, predicate) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off("message", onMessage);
      reject(new Error("WebSocket message timed out"));
    }, timeoutMs);
    const onMessage = (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (!predicate(message)) {
        return;
      }
      clearTimeout(timer);
      socket.off("message", onMessage);
      resolve(message);
    };
    socket.on("message", onMessage);
  });
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

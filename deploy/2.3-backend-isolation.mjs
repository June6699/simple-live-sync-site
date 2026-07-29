import WebSocket from "ws";

const primaryEndpoint =
  process.argv[2] ?? "wss://sync.furry.mo.cn/sync";
const backupEndpoint =
  process.argv[3] ?? "wss://simple-live-sync.3439394104.workers.dev/sync";
const timeoutMs = 8_000;

await assertIsolated(primaryEndpoint, backupEndpoint);
await assertIsolated(backupEndpoint, primaryEndpoint);

console.log(
  `Backend isolation passed: rooms are separate between ${primaryEndpoint} and ${backupEndpoint}`
);

async function assertIsolated(createEndpoint, joinEndpoint) {
  const creator = await connect(createEndpoint);
  const roomCreated = waitFor(
    creator,
    (message) => message.type === "roomCreated"
  );
  creator.send(
    JSON.stringify({
      type: "createRoom",
      requestId: "isolation-create",
      payload: {
        app: "Simple Live Isolation Check",
        platform: "node",
        version: "1.0.0"
      }
    })
  );
  const roomId = String((await roomCreated).roomId ?? "");
  assert(/^[A-Z2-9]{6}$/.test(roomId), `room creation failed at ${createEndpoint}`);

  const joiner = await connect(joinEndpoint);
  const rejected = waitFor(
    joiner,
    (message) => message.type === "error"
  );
  joiner.send(
    JSON.stringify({
      type: "joinRoom",
      requestId: "isolation-join",
      roomId,
      payload: {
        app: "Simple Live Isolation Check",
        platform: "node",
        version: "1.0.0"
      }
    })
  );
  const response = await rejected;
  assert(
    response.error?.code === "roomNotFound" ||
      response.error?.code === "roomExpired",
    `unexpected cross-backend response: ${JSON.stringify(response)}`
  );

  joiner.close(1000, "isolation check complete");
  creator.close(1000, "isolation check complete");
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

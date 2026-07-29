import WebSocket from "ws";

const endpoint = process.argv[2] ?? "wss://sync.furry.mo.cn/sync";
const timeoutMs = 8_000;

const creator = await connect(endpoint);
const ping = waitFor(creator, (message) => message.type === "pong");
creator.send(JSON.stringify({ type: "ping", requestId: "smoke-ping" }));
assert((await ping).requestId === "smoke-ping", "ping requestId mismatch");

const created = waitFor(creator, (message) => message.type === "roomCreated");
creator.send(
  JSON.stringify({
    type: "createRoom",
    requestId: "smoke-create",
    payload: { app: "Simple Live Smoke", platform: "node", version: "1.0.0" }
  })
);
const roomId = String((await created).roomId ?? "");
assert(/^[A-Z2-9]{6}$/.test(roomId), "room creation failed");

const joiner = await connect(endpoint);
const joined = waitFor(joiner, (message) => message.type === "roomJoined");
joiner.send(
  JSON.stringify({
    type: "joinRoom",
    requestId: "smoke-join",
    roomId,
    payload: { app: "Simple Live TV Smoke", platform: "tv", version: "1.0.0" }
  })
);
assert((await joined).roomId === roomId, "room join failed");

const actions = [
  ["sendFavorite", "favoriteReceived"],
  ["sendHistory", "historyReceived"],
  ["sendShieldWord", "shieldWordReceived"],
  ["sendBiliAccount", "biliAccountReceived"]
];

for (const [action, event] of actions) {
  const received = waitFor(joiner, (message) => message.type === event);
  const acknowledged = waitFor(
    creator,
    (message) => message.type === "ack" && message.requestId === action
  );
  creator.send(
    JSON.stringify({
      type: action,
      requestId: action,
      roomId,
      payload: { overlay: true, content: JSON.stringify([{ smoke: action }]) }
    })
  );
  assert((await received).roomId === roomId, `${event} was not relayed`);
  await acknowledged;
}

joiner.close(1000, "smoke complete");
creator.close(1000, "smoke complete");
console.log(`Public WebSocket smoke passed at ${endpoint}`);

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

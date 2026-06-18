import { DurableObject } from "cloudflare:workers";

export interface Env {
  ROOMS: DurableObjectNamespace<RoomHub>;
}

type ClientInfo = {
  app: string;
  platform: string;
  version: string;
};

type RoomUser = ClientInfo & {
  connectionId: string;
  shortId: string;
  isCreator: boolean;
};

type SyncRequest = {
  type?: string;
  roomId?: string;
  requestId?: string;
  payload?: unknown;
};

type ClientSession = {
  socket: WebSocket;
  user: RoomUser;
  roomId: string;
};

const VERSION = "0.1.0";
const SERVICE_ORIGIN = "https://simple-live-sync.3439394104.workers.dev";
const ROOM_TTL_MS = 600_000;
const HEARTBEAT_TIMEOUT_MS = 45_000;
const MAX_ROOM_CLIENTS = 8;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const SEND_EVENT_BY_ACTION: Record<string, string> = {
  sendFavorite: "favoriteReceived",
  sendHistory: "historyReceived",
  sendShieldWord: "shieldWordReceived",
  sendBiliAccount: "biliAccountReceived"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return html(renderHomePage(url.origin));
    }
    if (url.pathname === "/assets/app.js") {
      return javascript(renderAppScript());
    }
    if (url.pathname === "/health") {
      if (wantsHtml(request, url)) {
        return html(renderHealthPage(url.origin));
      }
      return json(buildHealthPayload());
    }
    if (url.pathname !== "/sync") {
      return json({ status: false, message: "not found" }, 404);
    }
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ status: false, message: "websocket upgrade required" }, 426);
    }
    const id = env.ROOMS.idFromName("global-room-hub");
    return env.ROOMS.get(id).fetch(request);
  }
};

export class RoomHub extends DurableObject {
  private readonly sessions = new Map<WebSocket, ClientSession>();
  private readonly rooms = new Map<string, Set<WebSocket>>();
  private readonly roomCreators = new Map<string, WebSocket>();
  private readonly roomExpiresAt = new Map<string, number>();
  private readonly lastSeen = new Map<WebSocket, number>();
  private heartbeatTimer?: ReturnType<typeof setInterval>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.attachSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  private attachSocket(socket: WebSocket): void {
    this.lastSeen.set(socket, Date.now());
    this.ensureHeartbeat();
    socket.addEventListener("message", (event) => {
      this.handleSocketMessage(socket, event.data).catch((error) => {
        this.sendError(socket, undefined, "serverError", stringifyError(error));
      });
    });
    socket.addEventListener("close", () => this.removeSocket(socket));
    socket.addEventListener("error", () => this.removeSocket(socket));
  }

  private async handleSocketMessage(socket: WebSocket, raw: unknown): Promise<void> {
    if (typeof raw !== "string") {
      this.sendError(socket, undefined, "invalidMessage", "message must be text");
      return;
    }
    if (new TextEncoder().encode(raw).byteLength > MAX_MESSAGE_BYTES) {
      this.sendError(socket, undefined, "payloadTooLarge", "message is larger than 1 MB");
      return;
    }
    let message: SyncRequest;
    try {
      message = JSON.parse(raw) as SyncRequest;
    } catch {
      this.sendError(socket, undefined, "invalidJson", "message is not valid JSON");
      return;
    }
    this.lastSeen.set(socket, Date.now());
    switch (message.type) {
      case "ping":
        this.send(socket, { type: "pong", requestId: message.requestId, serverTime: Date.now() });
        return;
      case "createRoom":
        this.createRoom(socket, message);
        return;
      case "joinRoom":
        this.joinRoom(socket, message);
        return;
      case "sendFavorite":
      case "sendHistory":
      case "sendShieldWord":
      case "sendBiliAccount":
        this.forwardContent(socket, message, message.type);
        return;
      case "leaveRoom":
        this.removeSocket(socket);
        return;
      default:
        this.sendError(socket, message.requestId, "unknownType", "unknown message type");
    }
  }

  private createRoom(socket: WebSocket, message: SyncRequest): void {
    const info = parseClientInfo(message.payload);
    if (!info) {
      this.sendError(socket, message.requestId, "invalidClient", "client info is invalid");
      return;
    }
    this.removeSocket(socket, false);
    const roomId = this.generateRoomId();
    const user = this.createRoomUser(info, true);
    this.rooms.set(roomId, new Set([socket]));
    this.roomCreators.set(roomId, socket);
    this.roomExpiresAt.set(roomId, Date.now() + ROOM_TTL_MS);
    this.sessions.set(socket, { socket, user, roomId });
    this.send(socket, {
      type: "roomCreated",
      requestId: message.requestId,
      roomId,
      expiresIn: Math.floor(ROOM_TTL_MS / 1000),
      user
    });
    this.broadcastUserUpdated(roomId);
  }

  private joinRoom(socket: WebSocket, message: SyncRequest): void {
    const roomId = normalizeRoomId(message.roomId);
    const info = parseClientInfo(message.payload);
    if (!roomId || !this.rooms.has(roomId)) {
      this.sendError(socket, message.requestId, "roomNotFound", "room not found");
      return;
    }
    if (this.isRoomExpired(roomId)) {
      this.destroyRoom(roomId, "expired");
      this.sendError(socket, message.requestId, "roomExpired", "room expired");
      return;
    }
    if (!info) {
      this.sendError(socket, message.requestId, "invalidClient", "client info is invalid");
      return;
    }
    const room = this.rooms.get(roomId)!;
    if (room.size >= MAX_ROOM_CLIENTS) {
      this.sendError(socket, message.requestId, "roomFull", "room is full");
      return;
    }
    this.removeSocket(socket, false);
    const user = this.createRoomUser(info, false);
    room.add(socket);
    this.sessions.set(socket, { socket, user, roomId });
    this.send(socket, {
      type: "roomJoined",
      requestId: message.requestId,
      roomId,
      expiresIn: Math.max(0, Math.floor((this.roomExpiresAt.get(roomId)! - Date.now()) / 1000)),
      user
    });
    this.broadcastUserUpdated(roomId);
  }

  private forwardContent(socket: WebSocket, message: SyncRequest, action: string): void {
    const roomId = normalizeRoomId(message.roomId);
    if (!roomId || !this.rooms.has(roomId)) {
      this.sendError(socket, message.requestId, "roomNotFound", "room not found");
      return;
    }
    if (this.isRoomExpired(roomId)) {
      this.destroyRoom(roomId, "expired");
      this.sendError(socket, message.requestId, "roomExpired", "room expired");
      return;
    }
    const sender = this.sessions.get(socket);
    if (!sender || !this.rooms.get(roomId)!.has(socket)) {
      this.sendError(socket, message.requestId, "notInRoom", "client is not in this room");
      return;
    }
    const payload = parseSyncPayload(message.payload);
    if (!payload) {
      this.sendError(socket, message.requestId, "invalidPayload", "sync payload is invalid");
      return;
    }
    const eventType = SEND_EVENT_BY_ACTION[action];
    for (const target of this.rooms.get(roomId)!) {
      if (target === socket) {
        continue;
      }
      this.send(target, {
        type: eventType,
        roomId,
        payload,
        from: sender.user
      });
    }
    this.send(socket, {
      type: "ack",
      requestId: message.requestId,
      action,
      roomId
    });
  }

  private removeSocket(socket: WebSocket, notify = true): void {
    const roomId = this.findRoomBySocket(socket);
    this.sessions.delete(socket);
    this.lastSeen.delete(socket);
    if (!roomId) {
      return;
    }
    const creator = this.roomCreators.get(roomId);
    if (creator === socket) {
      this.destroyRoom(roomId, "creatorDisconnected");
      return;
    }
    const room = this.rooms.get(roomId);
    room?.delete(socket);
    if (!room || room.size === 0) {
      this.rooms.delete(roomId);
      this.roomExpiresAt.delete(roomId);
      this.roomCreators.delete(roomId);
      return;
    }
    if (notify) {
      this.broadcastUserUpdated(roomId);
    }
  }

  private destroyRoom(roomId: string, reason: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    for (const socket of room) {
      this.send(socket, { type: "roomDestroyed", roomId, reason });
      this.sessions.delete(socket);
      this.lastSeen.delete(socket);
    }
    this.rooms.delete(roomId);
    this.roomCreators.delete(roomId);
    this.roomExpiresAt.delete(roomId);
  }

  private broadcastUserUpdated(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) {
      return;
    }
    const users = [...room]
      .map((socket) => this.sessions.get(socket)?.user)
      .filter((user): user is RoomUser => Boolean(user));
    for (const socket of room) {
      const currentUser = this.sessions.get(socket)?.user;
      this.send(socket, {
        type: "userUpdated",
        roomId,
        users: users.map((user) => ({
          ...user,
          isSelf: user.connectionId === currentUser?.connectionId
        }))
      });
    }
  }

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer) {
      return;
    }
    this.heartbeatTimer = setInterval(() => {
      const now = Date.now();
      for (const [socket, lastSeenAt] of this.lastSeen.entries()) {
        if (now - lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
          this.send(socket, { type: "roomDestroyed", reason: "heartbeatTimeout" });
          this.safeClose(socket, 1001, "heartbeat timeout");
          this.removeSocket(socket);
        }
      }
      for (const [roomId] of this.rooms) {
        if (this.isRoomExpired(roomId)) {
          this.destroyRoom(roomId, "expired");
        }
      }
      if (this.sessions.size === 0 && this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
      }
    }, 10_000);
  }

  private isRoomExpired(roomId: string): boolean {
    return (this.roomExpiresAt.get(roomId) ?? 0) <= Date.now();
  }

  private findRoomBySocket(socket: WebSocket): string | undefined {
    return this.sessions.get(socket)?.roomId;
  }

  private generateRoomId(): string {
    for (let attempt = 0; attempt < 100; attempt++) {
      let value = "";
      const bytes = new Uint8Array(6);
      crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        value += ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length];
      }
      if (!this.rooms.has(value)) {
        return value;
      }
    }
    throw new Error("failed to allocate room id");
  }

  private createRoomUser(info: ClientInfo, isCreator: boolean): RoomUser {
    const connectionId = crypto.randomUUID();
    return {
      connectionId,
      shortId: connectionId.slice(0, 8),
      app: info.app,
      platform: info.platform,
      version: info.version,
      isCreator
    };
  }

  private send(socket: WebSocket, payload: unknown): void {
    try {
      socket.send(JSON.stringify(payload));
    } catch {
      this.removeSocket(socket);
    }
  }

  private sendError(
    socket: WebSocket,
    requestId: string | undefined,
    code: string,
    message: string
  ): void {
    this.send(socket, {
      type: "error",
      requestId,
      error: { code, message }
    });
  }

  private safeClose(socket: WebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // ignored
    }
  }
}

function buildHealthPayload(): Record<string, unknown> {
  return {
    status: true,
    message: "simple live sync server is running",
    version: VERSION,
    now: new Date().toISOString(),
    limits: {
      roomTtlSeconds: ROOM_TTL_MS / 1000,
      maxRoomClients: MAX_ROOM_CLIENTS,
      maxMessageBytes: MAX_MESSAGE_BYTES
    },
    endpoints: {
      home: "/",
      health: "/health",
      sync: "/sync"
    }
  };
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "public, max-age=120"
    }
  });
}

function javascript(body: string): Response {
  return new Response(body, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "public, max-age=300"
    }
  });
}

function renderHomePage(origin: string): string {
  const syncUrl = `${origin.replace(/^http/, "ws")}/sync`;
  const canonicalSyncUrl = `${SERVICE_ORIGIN.replace(/^http/, "ws")}/sync`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Simple Live Sync</title>
  <meta name="description" content="Simple Live 远程同步临时房间服务状态页" />
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f6f7f4;
      --panel: #ffffff;
      --panel-soft: #eef3ef;
      --text: #17201a;
      --muted: #667067;
      --line: #dce3dd;
      --brand: #127c5b;
      --brand-dark: #0d5f48;
      --accent: #d7832f;
      --ok: #15915f;
      --warn: #b66a14;
      --shadow: 0 18px 50px rgba(23, 32, 26, .10);
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #101411;
        --panel: #171d19;
        --panel-soft: #1d2721;
        --text: #eaf0eb;
        --muted: #a2aea6;
        --line: #2c3931;
        --brand: #4cc49a;
        --brand-dark: #78ddb9;
        --accent: #e2a04f;
        --shadow: 0 18px 50px rgba(0, 0, 0, .26);
      }
    }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    a { color: var(--brand-dark); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .shell { width: min(1120px, calc(100% - 32px)); margin: 0 auto; }
    header { padding: 28px 0 18px; display: flex; align-items: center; justify-content: space-between; gap: 18px; }
    .brand { display: flex; align-items: center; gap: 12px; font-weight: 750; }
    .mark { width: 36px; height: 36px; border-radius: 8px; display: grid; place-items: center; color: white; background: linear-gradient(135deg, var(--brand), #325a9f); font-weight: 900; }
    nav { display: flex; gap: 14px; flex-wrap: wrap; font-size: 14px; color: var(--muted); }
    .hero { padding: 34px 0 24px; display: grid; grid-template-columns: minmax(0, 1.25fr) minmax(320px, .75fr); gap: 22px; align-items: stretch; }
    .hero-main, .card, .status-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow); }
    .hero-main { padding: clamp(24px, 4vw, 42px); }
    .eyebrow { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; border-radius: 999px; background: var(--panel-soft); color: var(--brand-dark); font-size: 13px; font-weight: 700; }
    h1 { margin: 18px 0 14px; font-size: clamp(34px, 7vw, 72px); line-height: .96; letter-spacing: 0; }
    .lead { margin: 0; max-width: 720px; color: var(--muted); font-size: clamp(16px, 2.2vw, 20px); line-height: 1.7; }
    .actions { display: flex; flex-wrap: wrap; gap: 12px; margin-top: 28px; }
    button, .button { border: 0; border-radius: 8px; padding: 11px 15px; font: inherit; font-weight: 700; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; }
    .primary { background: var(--brand); color: #fff; }
    .secondary { background: var(--panel-soft); color: var(--text); border: 1px solid var(--line); }
    .status-card { padding: 22px; display: flex; flex-direction: column; gap: 16px; }
    .status-line { display: flex; justify-content: space-between; gap: 14px; align-items: center; }
    .pill { border-radius: 999px; padding: 6px 10px; font-size: 13px; font-weight: 750; background: rgba(21,145,95,.12); color: var(--ok); }
    .metric { padding: 14px; background: var(--panel-soft); border-radius: 8px; border: 1px solid var(--line); }
    .metric span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 4px; }
    code { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; font-size: .92em; }
    .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 18px; margin: 20px 0; }
    .card { padding: 22px; box-shadow: none; }
    .card h2, .card h3 { margin: 0 0 12px; letter-spacing: 0; }
    .card p, .card li { color: var(--muted); line-height: 1.65; }
    .card ul, .card ol { padding-left: 20px; margin: 10px 0 0; }
    .wide { grid-column: span 2; }
    .downloads { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .download { padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel-soft); }
    .download strong { display: block; margin-bottom: 6px; }
    .diag { margin-top: 12px; padding: 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--panel-soft); min-height: 48px; color: var(--muted); }
    footer { padding: 28px 0 46px; color: var(--muted); font-size: 14px; }
    @media (max-width: 860px) {
      header, .hero { grid-template-columns: 1fr; }
      header { align-items: flex-start; flex-direction: column; }
      .grid, .downloads { grid-template-columns: 1fr; }
      .wide { grid-column: auto; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="brand"><div class="mark">SL</div><span>Simple Live Sync</span></div>
      <nav>
        <a href="#usage">使用</a>
        <a href="#diagnostics">检测</a>
        <a href="#privacy">隐私</a>
        <a href="https://github.com/June6699/dart_simple_live/releases">下载</a>
      </nav>
    </header>

    <main>
      <section class="hero">
        <div class="hero-main">
          <span class="eyebrow">远程同步临时房间服务</span>
          <h1>Simple Live Sync</h1>
          <p class="lead">用于 Simple Live App 和 TV 端之间临时同步关注、历史、屏蔽词和账号配置。服务只做 WebSocket 转发，不保存同步内容。</p>
          <div class="actions">
            <button class="primary" id="run-check">检测服务</button>
            <a class="button secondary" href="/health">查看 /health</a>
          </div>
        </div>
        <aside class="status-card" id="diagnostics">
          <div class="status-line"><strong>服务状态</strong><span class="pill" id="status-pill">等待检测</span></div>
          <div class="metric"><span>HTTP endpoint</span><code>${escapeHtml(origin)}/health</code></div>
          <div class="metric"><span>WebSocket endpoint</span><code>${escapeHtml(syncUrl)}</code></div>
          <div class="metric"><span>App 默认 endpoint</span><code>${escapeHtml(canonicalSyncUrl)}</code></div>
          <div class="diag" id="diag-output">点击“检测服务”后会检查 /health 和 WebSocket ping/pong。</div>
        </aside>
      </section>

      <section class="grid" id="usage">
        <article class="card">
          <h2>怎么使用</h2>
          <ol>
            <li>在一台设备中打开远程同步并创建房间。</li>
            <li>另一台设备扫码或输入房间号加入。</li>
            <li>选择要同步的关注、历史、屏蔽词或账号配置。</li>
          </ol>
        </article>
        <article class="card">
          <h2>服务限制</h2>
          <ul>
            <li>房间有效期 600 秒。</li>
            <li>创建者断开后房间销毁。</li>
            <li>单房间最多 8 个连接。</li>
            <li>单条消息最大 1 MB。</li>
          </ul>
        </article>
        <article class="card">
          <h2>常见失败原因</h2>
          <ul>
            <li>网络无法访问 workers.dev。</li>
            <li>代理或防火墙拦截 WebSocket。</li>
            <li>房间已过期或创建者已离开。</li>
          </ul>
        </article>
        <article class="card wide" id="privacy">
          <h2>隐私说明</h2>
          <p>该服务不保存关注列表、观看历史、Cookie、屏蔽词或其他同步内容。同步数据只在同一个临时房间内通过 WebSocket 转发，房间过期或创建者断开后即销毁。</p>
        </article>
        <article class="card">
          <h2>自建服务</h2>
          <p>Fork Worker 仓库后执行 <code>npm install</code>、<code>npm run typecheck</code>、<code>npm run deploy</code>。部署完成后，在 App 的“其他设置 -> 同步服务地址”填写自己的 <code>wss://.../sync</code>。</p>
        </article>
      </section>

      <section class="card">
        <h2>下载</h2>
        <div class="downloads">
          <a class="download" href="https://github.com/June6699/dart_simple_live/releases/tag/v1.12.5-fix"><strong>Simple Live v1.12.5-fix</strong><span>Android / Windows / Linux</span></a>
          <a class="download" href="https://github.com/June6699/dart_simple_live/releases/tag/tv_v1.7.6"><strong>Simple Live TV tv_1.7.6</strong><span>Android TV APK</span></a>
        </div>
      </section>
    </main>

    <footer>Simple Live Sync Worker · Version ${escapeHtml(VERSION)} · <a href="https://github.com/June6699/dart_simple_live">GitHub</a></footer>
  </div>
  <script src="/assets/app.js" defer></script>
</body>
</html>`;
}

function renderHealthPage(origin: string): string {
  const payload = buildHealthPayload();
  const syncUrl = `${origin.replace(/^http/, "ws")}/sync`;
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Simple Live Sync Health</title>
  <style>
    :root { color-scheme: light dark; --bg:#f6f7f4; --panel:#fff; --soft:#eef3ef; --text:#17201a; --muted:#667067; --line:#dce3dd; --ok:#15915f; --brand:#127c5b; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; }
    @media (prefers-color-scheme: dark) { :root { --bg:#101411; --panel:#171d19; --soft:#1d2721; --text:#eaf0eb; --muted:#a2aea6; --line:#2c3931; --brand:#4cc49a; } }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px; background: var(--bg); color: var(--text); }
    main { width: min(760px, 100%); background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: clamp(22px, 5vw, 38px); box-shadow: 0 18px 50px rgba(23,32,26,.10); }
    a { color: var(--brand); text-decoration: none; font-weight: 700; }
    a:hover { text-decoration: underline; }
    .top { display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
    .pill { padding: 7px 11px; border-radius: 999px; background: rgba(21,145,95,.12); color: var(--ok); font-weight: 800; font-size: 14px; }
    h1 { margin: 18px 0 8px; font-size: clamp(30px, 7vw, 54px); line-height: 1; letter-spacing: 0; }
    p { color: var(--muted); line-height: 1.7; }
    .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 22px 0; }
    .metric { padding: 14px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
    .metric span { display: block; color: var(--muted); font-size: 13px; margin-bottom: 5px; }
    code { word-break: break-all; font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
    .actions { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 22px; }
    .button { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; border-radius: 8px; padding: 0 14px; background: var(--brand); color: white; text-decoration: none; }
    .button.secondary { background: var(--soft); color: var(--text); border: 1px solid var(--line); }
    @media (max-width: 620px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="top"><strong>Simple Live Sync</strong><span class="pill">ONLINE</span></div>
    <h1>服务正常</h1>
    <p>远程同步 Worker 正在运行。App 使用 <code>/sync</code> WebSocket 端点创建或加入临时同步房间。</p>
    <div class="grid">
      <div class="metric"><span>Version</span><code>${escapeHtml(String(payload.version))}</code></div>
      <div class="metric"><span>Checked At</span><code>${escapeHtml(String(payload.now))}</code></div>
      <div class="metric"><span>Room TTL</span><code>${ROOM_TTL_MS / 1000} seconds</code></div>
      <div class="metric"><span>Max Clients</span><code>${MAX_ROOM_CLIENTS}</code></div>
      <div class="metric"><span>Health JSON</span><code>${escapeHtml(origin)}/health?format=json</code></div>
      <div class="metric"><span>WebSocket</span><code>${escapeHtml(syncUrl)}</code></div>
    </div>
    <div class="actions">
      <a class="button" href="/">返回首页</a>
      <a class="button secondary" href="/health?format=json">查看 JSON</a>
    </div>
  </main>
</body>
</html>`;
}

function wantsHtml(request: Request, url: URL): boolean {
  if (url.searchParams.get("format") === "json") {
    return false;
  }
  if (url.searchParams.get("format") === "html") {
    return true;
  }
  return request.headers.get("accept")?.includes("text/html") === true;
}

function renderAppScript(): string {
  return `const button = document.getElementById("run-check");
const output = document.getElementById("diag-output");
const pill = document.getElementById("status-pill");

function setStatus(text, ok) {
  pill.textContent = text;
  pill.style.color = ok ? "var(--ok)" : "var(--warn)";
}

function line(text) {
  output.textContent += (output.textContent ? "\\n" : "") + text;
}

async function checkHealth() {
  const started = performance.now();
  const response = await fetch("/health", { cache: "no-store" });
  const data = await response.json();
  if (!response.ok || data.status !== true) {
    throw new Error("/health returned an unhealthy response");
  }
  line("/health OK · " + Math.round(performance.now() - started) + " ms · version " + data.version);
}

function checkWebSocket() {
  return new Promise((resolve, reject) => {
    const wsUrl = location.origin.replace(/^http/, "ws") + "/sync";
    const ws = new WebSocket(wsUrl);
    const requestId = "web-" + Date.now();
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error("WebSocket ping timeout"));
    }, 6000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "ping", requestId }));
    ws.onmessage = (event) => {
      const data = JSON.parse(event.data);
      if (data.type === "pong" && data.requestId === requestId) {
        clearTimeout(timer);
        line("WebSocket OK · ping/pong received");
        ws.close();
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error("WebSocket connection failed"));
    };
  });
}

button?.addEventListener("click", async () => {
  output.textContent = "";
  setStatus("检测中", true);
  button.disabled = true;
  try {
    await checkHealth();
    await checkWebSocket();
    setStatus("在线", true);
  } catch (error) {
    line("检测失败 · " + (error instanceof Error ? error.message : String(error)));
    setStatus("异常", false);
  } finally {
    button.disabled = false;
  }
});`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function parseClientInfo(raw: unknown): ClientInfo | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const app = safeText(value.app, 40);
  const platform = safeText(value.platform, 40);
  const version = safeText(value.version, 40);
  if (!app || !platform || !version) {
    return null;
  }
  return { app, platform, version };
}

function parseSyncPayload(raw: unknown): { overlay: boolean; content: string } | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const content = typeof value.content === "string" ? value.content : "";
  if (!content) {
    return null;
  }
  return {
    overlay: value.overlay === true,
    content
  };
}

function normalizeRoomId(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const value = raw.trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(value) ? value : null;
}

function safeText(raw: unknown, maxLength: number): string {
  if (typeof raw !== "string") {
    return "";
  }
  return raw.trim().slice(0, maxLength);
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

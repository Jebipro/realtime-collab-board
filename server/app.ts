import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import { parseClientMessage, type ServerMessage } from "../shared/protocol";
import { Room, type Send } from "./room";

const HEARTBEAT_MS = 15_000;
const MAX_PAYLOAD = 16 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

export interface RunningServer {
  port: number;
  rooms: Map<string, Room>;
  close(): Promise<void>;
}

/**
 * HTTP + WebSocket server. Serves the built client from `staticDir` (if it
 * exists) with an SPA fallback, and the sync protocol on `/ws`.
 */
export function startServer(opts: { port: number; staticDir?: string }): Promise<RunningServer> {
  const rooms = new Map<string, Room>();
  const staticDir = opts.staticDir && existsSync(opts.staticDir) ? resolve(opts.staticDir) : null;

  const http: Server = createServer((req, res) => {
    if (!staticDir) {
      res.writeHead(404).end("Client not built. Use `npm run dev` or `npm run build`.");
      return;
    }
    const urlPath = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = normalize(join(staticDir, urlPath));
    if (!file.startsWith(staticDir) || !existsSync(file) || statSync(file).isDirectory()) {
      file = join(staticDir, "index.html"); // SPA fallback for /room/:id
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  });

  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: MAX_PAYLOAD });
  const alive = new WeakMap<WebSocket, boolean>();
  const socketOf = new WeakMap<Send, WebSocket>();

  wss.on("connection", (ws) => {
    // Protocol errors (oversized payload, invalid UTF-8) emit `error` before close.
    // Without a listener, one malformed frame terminates the entire Node process.
    ws.on("error", () => ws.terminate());
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));

    let joined: { room: Room; clientId: string; send: Send } | null = null;
    const send: Send = (msg: ServerMessage) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    socketOf.set(send, ws);

    ws.on("message", (data) => {
      const msg = parseClientMessage(data.toString());
      if (!msg) {
        send({ type: "error", message: "잘못된 메시지 형식입니다." });
        return;
      }
      if (msg.type === "join") {
        if (joined) return; // one room per connection
        let room = rooms.get(msg.roomId);
        if (!room) rooms.set(msg.roomId, (room = new Room(msg.roomId)));
        joined = { room, clientId: msg.clientId, send };
        const replaced = room.join(msg.clientId, msg.name, send);
        // Same clientId on a new socket: either a reconnect that beat the old
        // socket's timeout, or a duplicated tab. Close the old one with 4001 so
        // that client stops instead of reconnect-fighting.
        if (replaced) socketOf.get(replaced)?.close(4001, "replaced");
        return;
      }
      if (!joined) {
        send({ type: "error", message: "먼저 room에 join해야 합니다." });
        return;
      }
      if (msg.type === "sync") joined.room.sync(joined.clientId, joined.send);
      else joined.room.handleOp(joined.clientId, msg.op, joined.send);
    });

    ws.on("close", () => {
      if (joined) joined.room.leave(joined.clientId, joined.send);
    });
  });

  // Detect dead connections (closed laptop lids, dropped Wi-Fi) so presence stays accurate.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);

  return new Promise((resolvePromise) => {
    http.listen(opts.port, () => {
      const address = http.address();
      const port = typeof address === "object" && address ? address.port : opts.port;
      resolvePromise({
        port,
        rooms,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(heartbeat);
            for (const ws of wss.clients) ws.terminate();
            wss.close(() => http.close(() => done()));
          }),
      });
    });
  });
}

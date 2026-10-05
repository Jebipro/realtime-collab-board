import {
  parseServerMessage,
  type ClientMessage,
  type Op,
  type Participant,
  type ServerMessage,
} from "../../shared/protocol";
import {
  applyLocal,
  applyReject,
  applyServerOp,
  applySnapshot,
  initialSyncState,
  markAllUnsent,
  markSent,
  type SyncState,
} from "./syncState";

export type ConnectionStatus = "connecting" | "connected" | "reconnecting" | "offline" | "error";

export interface Connection {
  status: ConnectionStatus;
  /** 1-based retry attempt while reconnecting. */
  attempt: number;
  maxAttempts: number;
  /** Epoch ms of the next retry while reconnecting. */
  nextRetryAt: number | null;
  detail: string | null;
}

export interface Notice {
  id: number;
  message: string;
}

export interface BoardSnapshot {
  sync: SyncState;
  connection: Connection;
  participants: Participant[];
  notices: Notice[];
}

const MAX_ATTEMPTS = 8;
const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 8000;
const CONNECT_TIMEOUT_MS = 5000;
const NOTICE_MS = 5000;

export function backoffDelay(attempt: number, random = Math.random): number {
  const exp = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
  return Math.round(exp * (0.75 + random() * 0.5)); // ±25% jitter
}

/**
 * Owns one room session: socket lifecycle, reconnect/backoff, and the sync
 * state. Exposes an immutable snapshot for React's useSyncExternalStore.
 * Board data (`sync`) and connection state (`connection`) are kept separate.
 */
export class BoardClient {
  private state: BoardSnapshot;
  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private joined = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeSeq = 0;
  private disposed = false;

  constructor(
    readonly roomId: string,
    readonly clientId: string,
    private name: string,
    private url: string,
  ) {
    this.state = {
      sync: initialSyncState,
      connection: { status: "connecting", attempt: 0, maxAttempts: MAX_ATTEMPTS, nextRetryAt: null, detail: null },
      participants: [],
      notices: [],
    };
    window.addEventListener("online", this.onBrowserOnline);
    window.addEventListener("offline", this.onBrowserOffline);
    if (navigator.onLine === false) this.setConnection({ status: "offline", detail: "네트워크에 연결되어 있지 않습니다." });
    else this.connect();
  }

  // ---- store interface --------------------------------------------------

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  getSnapshot = () => this.state;

  private update(patch: Partial<BoardSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private setConnection(patch: Partial<Connection>) {
    this.update({ connection: { ...this.state.connection, ...patch } });
  }

  // ---- public actions -----------------------------------------------------

  /** Applies an op optimistically and sends it if connected. Returns false if it was invalid locally. */
  submit(op: Op): boolean {
    const r = applyLocal(this.state.sync, op, this.clientId);
    if (!r.ok) {
      this.notify(r.message);
      return false;
    }
    this.update({ sync: r.state });
    this.flush();
    return true;
  }

  retryNow() {
    this.clearTimers();
    this.setConnection({ attempt: 0 });
    this.connect();
  }

  dismissNotice(id: number) {
    this.update({ notices: this.state.notices.filter((n) => n.id !== id) });
  }

  /** Test/debug hook: drop the socket as if the network blipped. */
  simulateDrop() {
    this.ws?.close(4000, "simulated drop");
  }

  dispose() {
    this.disposed = true;
    this.clearTimers();
    window.removeEventListener("online", this.onBrowserOnline);
    window.removeEventListener("offline", this.onBrowserOffline);
    this.ws?.close(1000, "dispose");
    this.ws = null;
    this.listeners.clear();
  }

  // ---- connection lifecycle ----------------------------------------------

  private connect() {
    if (this.disposed) return;
    const reconnecting = this.state.connection.attempt > 0;
    this.setConnection({ status: reconnecting ? "reconnecting" : "connecting", nextRetryAt: null });

    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (err) {
      this.setConnection({ status: "error", detail: `연결을 만들 수 없습니다: ${String(err)}` });
      return;
    }
    this.ws = ws;
    this.joined = false;

    this.connectTimer = setTimeout(() => {
      if (!this.joined) ws.close(4002, "connect timeout");
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => this.send({ type: "join", roomId: this.roomId, clientId: this.clientId, name: this.name });
    ws.onmessage = (ev) => {
      const msg = parseServerMessage(String(ev.data));
      if (msg) this.onMessage(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.joined = false;
      this.clearTimers();
      // Anything in flight may or may not have reached the server; resend after resync.
      this.update({ sync: markAllUnsent(this.state.sync), participants: [] });
      if (this.disposed) return;
      if (ev.code === 4001) {
        this.setConnection({ status: "error", detail: "같은 세션이 다른 연결로 대체되었습니다. 새로고침하세요." });
        return;
      }
      if (navigator.onLine === false) {
        this.setConnection({ status: "offline", detail: "네트워크에 연결되어 있지 않습니다." });
        return;
      }
      this.scheduleRetry();
    };
  }

  private scheduleRetry() {
    const attempt = this.state.connection.attempt + 1;
    if (attempt > MAX_ATTEMPTS) {
      this.setConnection({ status: "offline", attempt: 0, nextRetryAt: null, detail: "서버에 연결할 수 없습니다." });
      return;
    }
    const delay = backoffDelay(attempt);
    this.setConnection({ status: "reconnecting", attempt, nextRetryAt: Date.now() + delay, detail: null });
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private onBrowserOnline = () => {
    if (this.state.connection.status === "offline") this.retryNow();
  };

  private onBrowserOffline = () => {
    this.clearTimers();
    this.ws?.close(4003, "browser offline");
  };

  private clearTimers() {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.retryTimer = this.connectTimer = null;
  }

  // ---- protocol -------------------------------------------------------------

  private send(msg: ClientMessage) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Sends every pending op not yet written to the current socket, in order. */
  private flush() {
    if (!this.joined) return;
    const sent = new Set<string>();
    for (const p of this.state.sync.pending) {
      if (p.sent) continue;
      this.send({ type: "op", op: p.op });
      sent.add(p.op.opId);
    }
    if (sent.size) this.update({ sync: markSent(this.state.sync, sent) });
  }

  private onMessage(msg: ServerMessage) {
    switch (msg.type) {
      case "welcome":
        this.joined = true;
        this.clearTimers();
        this.update({
          sync: applySnapshot(this.state.sync, msg.snapshot, this.clientId),
          participants: msg.participants,
        });
        this.setConnection({ status: "connected", attempt: 0, nextRetryAt: null, detail: null });
        this.flush(); // resend queued/unacknowledged ops on top of the fresh snapshot
        return;
      case "snapshot":
        this.update({ sync: applySnapshot(this.state.sync, msg.snapshot, this.clientId) });
        return;
      case "op": {
        const r = applyServerOp(this.state.sync, msg, this.clientId);
        this.update({ sync: r.state });
        if (r.needsSync) this.send({ type: "sync" });
        return;
      }
      case "reject": {
        const r = applyReject(this.state.sync, msg.opId, this.clientId);
        this.update({ sync: r.state });
        if (r.op) this.notify(`변경이 취소되었습니다: ${msg.message}`);
        return;
      }
      case "presence":
        this.update({ participants: msg.participants });
        return;
      case "error":
        this.notify(`서버 오류: ${msg.message}`);
        return;
    }
  }

  private notify(message: string) {
    const id = ++this.noticeSeq;
    this.update({ notices: [...this.state.notices, { id, message }].slice(-4) });
    setTimeout(() => this.dismissNotice(id), NOTICE_MS);
  }
}

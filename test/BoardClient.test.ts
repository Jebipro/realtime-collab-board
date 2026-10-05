import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoardClient } from "../src/sync/BoardClient";
import { Room } from "../server/room";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import { create, move, update } from "./fixtures";

class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  sent: ClientMessage[] = [];
  constructor() { Socket.all.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data) as ClientMessage); }
  close() { this.readyState = 2; } // delay close event to exercise old callbacks
  open() { this.readyState = 1; this.onopen?.(); }
  message(msg: ServerMessage) { this.onmessage?.({ data: JSON.stringify(msg) }); }
  closed(code = 1006) { this.readyState = 3; this.onclose?.({ code }); }
}

let client: BoardClient;
let browser: EventTarget;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  browser = new EventTarget();
  vi.stubGlobal("window", browser);
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("WebSocket", Socket);
  client = new BoardClient("r", "a", "Alice", "ws://test");
});
afterEach(() => { client.dispose(); vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function join(ws: Socket, room = new Room("r")) {
  ws.open();
  room.join("a", "Alice", (msg) => ws.message(msg));
  return room;
}

describe("socket generation and pending delivery", () => {
  it("ignores late messages and open events from a replaced socket", () => {
    const old = Socket.all[0];
    join(old);
    client.retryNow();
    expect(old.readyState).toBe(2);
    const current = Socket.all[1];
    join(current);
    const sent = current.sent.length;
    old.onopen?.();
    old.message({ type: "snapshot", snapshot: { revision: 99, cards: [] } });
    old.message({ type: "presence", participants: [{ clientId: "ghost", name: "Ghost" }] });
    old.closed(4001);
    expect(current.sent).toHaveLength(sent);
    expect(client.getSnapshot().sync.revision).toBe(0);
    expect(client.getSnapshot().participants.map((p) => p.clientId)).toEqual(["a"]);
    expect(client.getSnapshot().connection.status).toBe("connected");
    expect(old.readyState).toBe(3);
  });

  it("resends in-flight ops when manual retry replaces a socket before its close event", () => {
    const old = Socket.all[0];
    join(old);
    const op = create("c");
    client.submit(op);
    client.retryNow();
    const current = Socket.all[1];
    join(current);
    expect(current.sent.filter((m) => m.type === "op")).toEqual([{ type: "op", op }]);
  });

  it("reconnects after offline interrupts a backoff timer while there is no socket", () => {
    const ws = Socket.all[0];
    join(ws);
    ws.closed();
    vi.stubGlobal("navigator", { onLine: false });
    browser.dispatchEvent(new Event("offline"));
    expect(client.getSnapshot().connection.status).toBe("offline");
    vi.stubGlobal("navigator", { onLine: true });
    browser.dispatchEvent(new Event("online"));
    expect(Socket.all).toHaveLength(2);
  });

  it("settles ack loss plus offline create/edit/move exactly once through BoardClient", () => {
    const room = new Room("r");
    const old = Socket.all[0];
    join(old, room);
    const lost = create("first");
    client.submit(lost);
    room.join("a", "Alice", () => {}); // server accepts; client receives no ack
    room.handleOp("a", lost);
    old.closed();
    const offline = create("offline");
    const edit = update("offline", "queued text", 0);
    const moved = move("offline", 40, 50);
    client.submit(offline);
    client.submit(edit);
    client.submit(moved);
    client.retryNow();
    const current = Socket.all.at(-1)!;
    join(current, room);
    const ops = current.sent.filter((m) => m.type === "op");
    for (const m of ops) room.handleOp("a", m.op);
    expect(room.snapshot().revision).toBe(4);
    expect(client.getSnapshot().sync.pending).toEqual([]);
    expect(Object.values(client.getSnapshot().sync.confirmed)).toEqual(room.snapshot().cards);
    expect(client.getSnapshot().sync.view).toEqual(client.getSnapshot().sync.confirmed);
    for (const m of ops) room.handleOp("a", m.op);
    expect(room.snapshot().revision).toBe(4);
  });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { ClientMessage, ServerMessage } from "../shared/protocol";
import { startServer, type RunningServer } from "../server/app";
import { create, update } from "./fixtures";

let server: RunningServer;

beforeEach(async () => {
  server = await startServer({ port: 0 });
});
afterEach(async () => {
  await server.close();
});

/** Minimal test client: records every server message and can await one by predicate. */
async function connect(clientId: string, name: string, roomId = "it-room") {
  const ws = new WebSocket(`ws://localhost:${server.port}/ws`);
  const inbox: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;
    inbox.push(msg);
    for (const w of [...waiters]) {
      if (w.pred(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  await new Promise((r) => ws.once("open", r));
  const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
  const next = <T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs = 2000) =>
    new Promise<T>((resolve, reject) => {
      const seen = inbox.find(pred);
      if (seen) {
        inbox.splice(inbox.indexOf(seen), 1);
        return resolve(seen);
      }
      const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
      waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(t);
          inbox.splice(inbox.indexOf(m), 1);
          resolve(m as T);
        },
      });
    });
  send({ type: "join", roomId, clientId, name });
  const welcome = await next((m): m is Extract<ServerMessage, { type: "welcome" }> => m.type === "welcome");
  return { ws, send, next, welcome };
}

const isOp = (opId: string) => (m: ServerMessage): m is Extract<ServerMessage, { type: "op" }> =>
  m.type === "op" && m.op.opId === opId;
const isReject = (m: ServerMessage): m is Extract<ServerMessage, { type: "reject" }> => m.type === "reject";
const isPresence = (n: number) => (m: ServerMessage): m is Extract<ServerMessage, { type: "presence" }> =>
  m.type === "presence" && m.participants.length === n;

describe("WebSocket server", () => {
  it.each(["oversized", "invalid UTF-8"])("survives a %s WebSocket frame", async (kind) => {
    const a = await connect("a", "Alice");
    const closed = new Promise<void>((resolve) => a.ws.once("close", () => resolve()));
    a.ws.send(kind === "oversized" ? Buffer.alloc(16 * 1024 + 1) : Buffer.from([0xff]), { binary: false });
    await closed;
    const b = await connect("b", "Bob");
    const op = create("still-alive");
    b.send({ type: "op", op });
    expect(await b.next(isOp(op.opId))).toMatchObject({ revision: 1 });
    b.ws.close();
  });

  it("broadcasts A's op to B and keeps presence in sync on disconnect", async () => {
    const a = await connect("a", "Alice");
    const b = await connect("b", "Bob");
    await a.next(isPresence(2));

    const op = create("c1", "hello");
    a.send({ type: "op", op });
    const atB = await b.next(isOp(op.opId));
    expect(atB).toMatchObject({ revision: 1, by: "a" });
    await a.next(isOp(op.opId)); // sender gets the same broadcast as its ack

    a.ws.close();
    const presence = await b.next(isPresence(1));
    expect(presence.participants[0].name).toBe("Bob");
    b.ws.close();
  });

  it("concurrent edits of the same text: first wins, second is rejected as stale", async () => {
    const a = await connect("a", "Alice");
    const b = await connect("b", "Bob");
    const c = create("c1");
    a.send({ type: "op", op: c });
    await b.next(isOp(c.opId));

    // Both started editing at textVersion 0.
    const ea = update("c1", "A wins", 0);
    const eb = update("c1", "B loses", 0);
    a.send({ type: "op", op: ea });
    b.send({ type: "op", op: eb });

    await b.next(isOp(ea.opId));
    const rej = await b.next(isReject);
    expect(rej).toMatchObject({ opId: eb.opId, reason: "stale" });

    const late = await connect("z", "Late");
    expect(late.welcome.snapshot.cards[0]).toMatchObject({ text: "A wins", textVersion: 1 });
    expect(late.welcome.snapshot.revision).toBe(2);
    for (const x of [a, b, late]) x.ws.close();
  });

  it("reconnect: snapshot reflects changes made while away and a resent op is not applied twice", async () => {
    const a = await connect("a", "Alice");
    const b = await connect("b", "Bob");
    const op = create("c1", "from A");
    a.send({ type: "op", op });
    await a.next(isOp(op.opId));
    a.ws.close(); // pretend A never saw that ack arrive

    const other = create("c2", "from B while A away");
    b.send({ type: "op", op: other });
    await b.next(isOp(other.opId));

    const a2 = await connect("a", "Alice");
    expect(a2.welcome.snapshot.revision).toBe(2);
    expect(a2.welcome.snapshot.cards.map((c) => c.id).sort()).toEqual(["c1", "c2"]);

    a2.send({ type: "op", op }); // resend of the unacknowledged op
    const dup = await a2.next(isOp(op.opId));
    expect(dup.revision).toBe(1); // original revision, not re-applied
    expect(server.rooms.get("it-room")!.snapshot().revision).toBe(2);
    for (const x of [a2, b]) x.ws.close();
  });

  it("answers malformed input with an error instead of dropping the connection", async () => {
    const a = await connect("a", "Alice");
    a.ws.send("garbage");
    const err = await a.next((m): m is Extract<ServerMessage, { type: "error" }> => m.type === "error");
    expect(err.message).toBeTruthy();
    expect(a.ws.readyState).toBe(WebSocket.OPEN);
    a.ws.close();
  });
});

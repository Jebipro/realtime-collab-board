import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../shared/protocol";
import { Room } from "../server/room";
import { create, move, update } from "./fixtures";

function member() {
  const inbox: ServerMessage[] = [];
  const send = (m: ServerMessage) => void inbox.push(m);
  const of = <T extends ServerMessage["type"]>(type: T) =>
    inbox.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  return { inbox, send, of };
}

describe("Room", () => {
  it("welcomes with a snapshot and broadcasts presence on join/leave", () => {
    const room = new Room("r");
    const a = member();
    const b = member();
    room.join("a", "Alice", a.send);
    room.join("b", "Bob", b.send);

    expect(b.of("welcome")[0].snapshot).toEqual({ revision: 0, cards: [] });
    expect(a.of("presence").at(-1)!.participants.map((p) => p.name)).toEqual(["Alice", "Bob"]);

    room.leave("b", b.send);
    expect(a.of("presence").at(-1)!.participants.map((p) => p.name)).toEqual(["Alice"]);
  });

  it("increments revision per accepted op and broadcasts to everyone including the sender", () => {
    const room = new Room("r");
    const a = member();
    const b = member();
    room.join("a", "A", a.send);
    room.join("b", "B", b.send);

    room.handleOp("a", create("c1"));
    room.handleOp("b", move("c1", 10, 20));

    expect(a.of("op").map((m) => m.revision)).toEqual([1, 2]);
    expect(b.of("op").map((m) => m.revision)).toEqual([1, 2]);
    expect(b.of("op")[0].by).toBe("a");
    expect(room.snapshot().revision).toBe(2);
    // The client sent authorName "Tester"; the server stamps the member's own name.
    expect(room.snapshot().cards[0].authorName).toBe("A");
  });

  it("rejects a stale text edit to the sender only and does not bump revision", () => {
    const room = new Room("r");
    const a = member();
    const b = member();
    room.join("a", "A", a.send);
    room.join("b", "B", b.send);
    room.handleOp("a", create("c1"));

    room.handleOp("a", update("c1", "from A", 0)); // accepted -> textVersion 1
    const stale = update("c1", "from B", 0); // B started editing at version 0
    room.handleOp("b", stale);

    expect(b.of("reject")).toEqual([
      { type: "reject", opId: stale.opId, reason: "stale", message: expect.any(String) },
    ]);
    expect(a.of("reject")).toEqual([]);
    expect(room.snapshot().revision).toBe(2);
    expect(room.snapshot().cards[0].text).toBe("from A");
  });

  it("acks a retried opId without re-applying or re-broadcasting", () => {
    const room = new Room("r");
    const a = member();
    const b = member();
    room.join("a", "A", a.send);
    room.join("b", "B", b.send);
    const op = create("c1");

    room.handleOp("a", op);
    room.handleOp("a", op); // e.g. resent after reconnect because the ack was lost

    expect(a.of("op").map((m) => [m.op.opId, m.revision])).toEqual([
      [op.opId, 1],
      [op.opId, 1],
    ]);
    expect(b.of("op")).toHaveLength(1);
    expect(a.of("reject")).toEqual([]);
    expect(room.snapshot().revision).toBe(1);
  });

  it("a rejoin with the same clientId replaces the old connection; the old leave is ignored", () => {
    const room = new Room("r");
    const oldConn = member();
    const newConn = member();
    room.join("a", "A", oldConn.send);
    const replaced = room.join("a", "A", newConn.send);

    expect(replaced).toBe(oldConn.send);
    room.leave("a", oldConn.send); // late close of the old socket
    expect(room.participants().map((p) => p.clientId)).toEqual(["a"]);
  });
});

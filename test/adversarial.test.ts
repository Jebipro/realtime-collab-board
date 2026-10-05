import { describe, expect, it } from "vitest";
import { Room } from "../server/room";
import { applyOp, cardsFromList } from "../shared/board";
import { parseClientMessage, parseServerMessage, type ServerMessage } from "../shared/protocol";
import { applyLocal, applyReject, applyServerOp, applySnapshot, initialSyncState, markAllUnsent, markSent } from "../src/sync/syncState";
import { create, del, move, update } from "./fixtures";

function setup() {
  const room = new Room("r");
  const inbox: ServerMessage[] = [];
  const send = (m: ServerMessage) => { inbox.push(m); };
  room.join("a", "Alice", send);
  return { room, inbox, send };
}

describe("adversarial retry receipts", () => {
  it("ignores commands from the replaced connection, preserving author and presence", () => {
    const { room, send } = setup();
    const inbox: ServerMessage[] = [];
    const current = (m: ServerMessage) => { inbox.push(m); };
    room.handleOp("a", create("existing"));
    room.join("a", "Renamed", current);
    const before = room.snapshot();
    const count = inbox.length;
    room.handleOp("a", create("late-old-socket"), send);
    room.sync("a", send);
    room.leave("a", send);
    expect(room.snapshot()).toEqual(before);
    expect(inbox).toHaveLength(count);
    expect(room.participants()).toEqual([{ clientId: "a", name: "Renamed" }]);
    expect(room.snapshot().cards[0]).toMatchObject({ createdBy: "a", authorName: "Alice" });
    room.handleOp("a", create("new-socket"), current);
    expect(room.snapshot().cards[1]).toMatchObject({ createdBy: "a", authorName: "Renamed" });
  });

  it("does not resurrect an ack-lost create after deletion and 2000 later ops", () => {
    const { room, send } = setup();
    const c = create("gone");
    room.handleOp("a", c);
    room.handleOp("a", del("gone"));
    room.handleOp("a", create("live"));
    for (let i = 0; i < 2001; i++) room.handleOp("a", move("live", i % 100, 0));
    const before = room.snapshot();
    room.leave("a", send);
    room.join("a", "Alice", send);
    room.handleOp("a", c);
    expect(room.snapshot()).toEqual(before);
  });

  it("returns the original canonical ack even if retry payload or display name changed", () => {
    const { room, inbox, send } = setup();
    const c = create("card");
    room.handleOp("a", c);
    const original = inbox.at(-1);
    room.join("a", "Renamed", send);
    room.handleOp("a", { ...move("card", 99, 99), opId: c.opId });
    expect(inbox.at(-1)).toEqual(original);
  });

  it("rejects another client's opId collision instead of acknowledging an unapplied op", () => {
    const { room, inbox, send } = setup();
    room.join("b", "Bob", send);
    const c = create("card");
    room.handleOp("a", c);
    room.handleOp("b", { ...create("different"), opId: c.opId });
    expect(inbox.at(-1)).toMatchObject({ type: "reject", opId: c.opId, reason: "invalid" });
    expect(room.snapshot().revision).toBe(1);
  });

  it("keeps rejection terminal when a previously missing card later exists", () => {
    const { room, inbox } = setup();
    const op = move("later", 50, 50);
    room.handleOp("a", op);
    room.handleOp("a", create("later"));
    room.handleOp("a", op);
    expect(inbox.at(-1)).toMatchObject({ type: "reject", reason: "not_found" });
    expect(room.snapshot()).toMatchObject({ revision: 1, cards: [{ x: 0, y: 0 }] });
  });
});

describe("adversarial snapshot replay", () => {
  it("does not optimistically resurrect an already accepted then deleted pending create", () => {
    const c = create("gone");
    const local = applyLocal(initialSyncState, c, "a");
    if (!local.ok) throw new Error(local.reason);
    let state = markAllUnsent(markSent(local.state, new Set([c.opId])));
    state = applySnapshot(state, { revision: 2, cards: [] }, "a");
    expect(Object.values(state.view)).toEqual([]);
    expect(state.pending).toHaveLength(1); // still resend to obtain its receipt
    state = applyServerOp(state, { revision: 1, op: c, by: "a" }, "a").state;
    expect(state.pending).toEqual([]);
    expect(state.view).toEqual(state.confirmed);
  });

  it("does not replay an ack-lost move over a newer remote position", () => {
    const { room } = setup();
    room.handleOp("a", create("c"));
    let state = applySnapshot(initialSyncState, room.snapshot(), "a");
    const op = move("c", 10, 10);
    const local = applyLocal(state, op, "a");
    if (!local.ok) throw new Error(local.reason);
    state = markAllUnsent(markSent(local.state, new Set([op.opId])));
    room.handleOp("a", op);
    room.handleOp("a", move("c", 80, 80));
    state = applySnapshot(state, room.snapshot(), "a");
    expect(state.view.c).toMatchObject({ x: 80, y: 80 });
  });

  it("does not acknowledge a local pending op from another author", () => {
    const op = create("c");
    const local = applyLocal(initialSyncState, op, "a");
    if (!local.ok) throw new Error(local.reason);
    const state = applyServerOp(local.state, { revision: 1, op: { ...create("other"), opId: op.opId }, by: "b" }, "a").state;
    expect(state.pending).toHaveLength(1);
  });

  it("retains the rejected text and its base after the other edit wins", () => {
    const { room } = setup();
    room.handleOp("a", create("c"));
    let state = applySnapshot(initialSyncState, room.snapshot(), "a");
    const draft = update("c", "irreplaceable draft", 0);
    const local = applyLocal(state, draft, "a");
    if (!local.ok) throw new Error(local.reason);
    state = applyServerOp(local.state, { revision: 2, op: update("c", "winner", 0), by: "b" }, "a").state;
    state = applyReject(state, draft.opId, "a").state;
    expect(state.rejectedEdits.get("c")).toEqual(draft);
    expect(state.pending).toEqual([]);
    expect(state.view.c.text).toBe("winner");
    const retry = applyLocal(state, update("c", "resolved", 1), "a");
    if (!retry.ok) throw new Error(retry.reason);
    expect(retry.state.rejectedEdits.has("c")).toBe(false);
  });
});

describe("hostile protocol values", () => {
  it.each(["constructor", "__proto__", "toString"])("treats %s as an ordinary card id", (id) => {
    expect(applyOp({}, move(id, 1, 1), "a")).toMatchObject({ ok: false, reason: "not_found" });
    const r = applyOp({}, create(id), "a");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const roundtrip = cardsFromList(Object.values(r.cards));
    expect(Object.keys(roundtrip)).toEqual([id]);
    expect(Object.hasOwn(roundtrip, id)).toBe(true);
  });

  it.each([-1, Number.MAX_SAFE_INTEGER + 1])("rejects invalid text version %s", (baseTextVersion) => {
    expect(parseClientMessage(JSON.stringify({ type: "op", op: update("c", "text", baseTextVersion) }))).toBeNull();
  });

  it.each([
    { type: "op" },
    { type: "op", revision: -1, op: create("c"), by: "a" },
    { type: "welcome", snapshot: {}, participants: [] },
    { type: "snapshot", snapshot: { revision: 1, cards: [null] } },
    { type: "presence", participants: [null] },
    { type: "reject", opId: "x", reason: "bogus", message: "no" },
    { type: "unknown" },
  ])("rejects malformed server frame %#", (msg) => {
    expect(parseServerMessage(JSON.stringify(msg))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import type { Op, Snapshot } from "../shared/protocol";
import {
  applyLocal,
  applyReject,
  applyServerOp,
  applySnapshot,
  hasPendingText,
  initialSyncState,
  markAllUnsent,
  markSent,
  type SyncState,
} from "../src/sync/syncState";
import { backoffDelay } from "../src/sync/BoardClient";
import { create, del, move, update } from "./fixtures";

const ME = "me";
const OTHER = "other";

function local(s: SyncState, op: Op): SyncState {
  const r = applyLocal(s, op, ME);
  if (!r.ok) throw new Error(r.reason);
  return r.state;
}

/** A loaded state containing card c1 at revision 1. */
function loaded(): SyncState {
  const snap: Snapshot = {
    revision: 1,
    cards: [{ id: "c1", x: 0, y: 0, text: "hello", color: "yellow", textVersion: 0, createdBy: OTHER, authorName: "Other" }],
  };
  return applySnapshot(initialSyncState, snap, ME);
}

describe("optimistic local apply", () => {
  it("shows the change immediately while confirmed state is untouched", () => {
    const s = local(loaded(), move("c1", 50, 60));
    expect(s.view.c1).toMatchObject({ x: 50, y: 60 });
    expect(s.confirmed.c1).toMatchObject({ x: 0, y: 0 });
    expect(s.pending).toHaveLength(1);
  });

  it("refuses ops that are invalid against the current view", () => {
    expect(applyLocal(loaded(), move("nope", 1, 1), ME)).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("coalesces consecutive unsent moves of the same card", () => {
    let s = local(loaded(), move("c1", 1, 1));
    s = local(s, move("c1", 2, 2));
    expect(s.pending).toHaveLength(1);
    s = markSent(s, new Set([s.pending[0].op.opId]));
    s = local(s, move("c1", 3, 3)); // previous one is in flight: must not be dropped
    expect(s.pending).toHaveLength(2);
  });
});

describe("server ack / remote ops", () => {
  it("ack: moves own op from pending into confirmed", () => {
    const op = move("c1", 50, 60);
    let s = local(loaded(), op);
    s = applyServerOp(s, { revision: 2, op, by: ME }, ME).state;
    expect(s.pending).toEqual([]);
    expect(s.revision).toBe(2);
    expect(s.confirmed.c1).toMatchObject({ x: 50, y: 60 });
    expect(s.view).toEqual(s.confirmed);
  });

  it("remote op is applied under still-pending local ops", () => {
    let s = local(loaded(), move("c1", 50, 60));
    s = applyServerOp(s, { revision: 2, op: update("c1", "remote text", 0), by: OTHER }, ME).state;
    // remote text + my pending position
    expect(s.view.c1).toMatchObject({ text: "remote text", x: 50, y: 60 });
    expect(s.pending).toHaveLength(1);
  });

  it("a revision gap asks for a snapshot and settles own ops meanwhile", () => {
    const mine = move("c1", 5, 5);
    let s = local(loaded(), mine);
    const r = applyServerOp(s, { revision: 3, op: move("c1", 9, 9), by: OTHER }, ME); // missed rev 2
    expect(r.needsSync).toBe(true);
    s = r.state;
    expect(s.awaitingSnapshot).toBe(true);
    s = applyServerOp(s, { revision: 4, op: mine, by: ME }, ME).state;
    expect(s.pending).toEqual([]);
    expect(s.revision).toBe(1); // unchanged until the snapshot arrives
  });

  it("a duplicate ack (revision already confirmed) only clears pending", () => {
    const op = create("c2", "x");
    let s = local(loaded(), op);
    s = applySnapshot(s, { revision: 5, cards: [...Object.values(s.confirmed)] }, ME);
    s = applyServerOp(s, { revision: 2, op, by: ME }, ME).state;
    expect(s.pending).toEqual([]);
    expect(s.revision).toBe(5);
  });
});

describe("reject / rollback", () => {
  it("removes the op and recomputes the view from confirmed", () => {
    const op = update("c1", "my edit", 0);
    let s = local(loaded(), op);
    expect(s.view.c1.text).toBe("my edit");
    expect(hasPendingText(s, "c1")).toBe(true);

    const r = applyReject(s, op.opId, ME);
    s = r.state;
    expect(r.op).toBe(op);
    expect(s.view.c1.text).toBe("hello");
    expect(hasPendingText(s, "c1")).toBe(false);
  });

  it("later pending ops that depended on a rejected create disappear from the view", () => {
    const c = create("c2");
    let s = local(loaded(), c);
    s = local(s, move("c2", 10, 10));
    s = applyReject(s, c.opId, ME).state;
    expect(s.view.c2).toBeUndefined();
  });
});

describe("reconnect snapshot merge", () => {
  it("replaces confirmed with the snapshot and replays pending on top", () => {
    let s = local(loaded(), create("c2", "made offline", 100, 100));
    s = markAllUnsent(s);
    const snap: Snapshot = {
      revision: 7,
      cards: [{ id: "c1", x: 300, y: 300, text: "changed while away", color: "yellow", textVersion: 1, createdBy: OTHER, authorName: "Other" }],
    };
    s = applySnapshot(s, snap, ME);
    expect(s.revision).toBe(7);
    expect(s.view.c1).toMatchObject({ x: 300, text: "changed while away" });
    expect(s.view.c2).toMatchObject({ text: "made offline" });
    expect(s.pending.every((p) => !p.sent)).toBe(true); // will be resent
  });

  it("a pending edit on a card deleted while away is hidden in the view (server will reject it)", () => {
    let s = local(loaded(), move("c1", 1, 1));
    s = applySnapshot(s, { revision: 9, cards: [] }, ME);
    expect(s.view).toEqual({});
    expect(s.pending).toHaveLength(1);
  });

  it("a pending delete stays applied over a snapshot that still has the card", () => {
    let s = local(loaded(), del("c1"));
    s = applySnapshot(s, { revision: 3, cards: Object.values(loaded().confirmed) }, ME);
    expect(s.view.c1).toBeUndefined();
  });
});

describe("backoff", () => {
  it("grows exponentially and is capped", () => {
    const mid = () => 0.5; // no jitter
    expect([1, 2, 3, 4, 5, 6, 8].map((a) => backoffDelay(a, mid))).toEqual([500, 1000, 2000, 4000, 8000, 8000, 8000]);
  });
});

import { describe, expect, it } from "vitest";
import { applyOp, type Cards } from "../shared/board";
import { create, del, move, update } from "./fixtures";

function apply(cards: Cards, ...ops: Parameters<typeof applyOp>[1][]): Cards {
  for (const op of ops) {
    const r = applyOp(cards, op, "u1");
    if (!r.ok) throw new Error(r.reason);
    cards = r.cards;
  }
  return cards;
}

describe("applyOp", () => {
  it("creates, edits, moves and deletes without mutating input", () => {
    const empty: Cards = {};
    const one = apply(empty, create("c1", "hi"));
    expect(empty).toEqual({});
    expect(one.c1).toMatchObject({ text: "hi", textVersion: 0, createdBy: "u1" });

    const edited = apply(one, update("c1", "hello", 0));
    expect(edited.c1).toMatchObject({ text: "hello", textVersion: 1 });
    expect(one.c1.text).toBe("hi");

    const moved = apply(edited, move("c1", 40, 50));
    expect(moved.c1).toMatchObject({ x: 40, y: 50, textVersion: 1 });

    expect(apply(moved, del("c1"))).toEqual({});
  });

  it("puts a moved card on top (last key)", () => {
    const cards = apply({}, create("a"), create("b"), move("a", 10, 10));
    expect(Object.keys(cards)).toEqual(["b", "a"]);
  });

  it("rejects a text edit based on an old textVersion as stale", () => {
    const cards = apply({}, create("c1"), update("c1", "first", 0));
    const r = applyOp(cards, update("c1", "second", 0), "u2");
    expect(r).toMatchObject({ ok: false, reason: "stale" });
  });

  it("moves are last-write-wins with no stale check", () => {
    const cards = apply({}, create("c1"), move("c1", 1, 1), move("c1", 2, 2));
    expect(cards.c1).toMatchObject({ x: 2, y: 2 });
  });

  it("delete wins: later ops on the card fail with not_found", () => {
    const cards = apply({}, create("c1"), del("c1"));
    expect(applyOp(cards, move("c1", 0, 0), "u")).toMatchObject({ ok: false, reason: "not_found" });
    expect(applyOp(cards, update("c1", "x", 0), "u")).toMatchObject({ ok: false, reason: "not_found" });
    expect(applyOp(cards, del("c1"), "u")).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("rejects duplicate ids and enforces the card limit", () => {
    const cards = apply({}, create("c1"));
    expect(applyOp(cards, create("c1"), "u")).toMatchObject({ ok: false, reason: "duplicate_id" });
    expect(applyOp(cards, create("c2"), "u", 1)).toMatchObject({ ok: false, reason: "limit" });
  });
});

import { describe, expect, it } from "vitest";
import { BOARD_WIDTH, CARD_WIDTH, MAX_TEXT_LENGTH, parseClientMessage } from "../shared/protocol";

const parse = (v: unknown) => parseClientMessage(JSON.stringify(v));

describe("parseClientMessage", () => {
  it("accepts a valid join and trims the name", () => {
    expect(parse({ type: "join", roomId: "team-1", clientId: "u_abc", name: "  Alice  " })).toEqual({
      type: "join",
      roomId: "team-1",
      clientId: "u_abc",
      name: "Alice",
    });
  });

  it("rejects bad room ids, empty names and non-JSON", () => {
    expect(parse({ type: "join", roomId: "../etc", clientId: "u", name: "A" })).toBeNull();
    expect(parse({ type: "join", roomId: "r", clientId: "u", name: "   " })).toBeNull();
    expect(parseClientMessage("{not json")).toBeNull();
    expect(parse({ type: "unknown" })).toBeNull();
  });

  it("clamps move coordinates into the board", () => {
    const msg = parse({ type: "op", op: { kind: "card.move", opId: "o1", cardId: "c1", x: 99999, y: -50 } });
    expect(msg).toEqual({
      type: "op",
      op: { kind: "card.move", opId: "o1", cardId: "c1", x: BOARD_WIDTH - CARD_WIDTH, y: 0 },
    });
  });

  it("rejects ops with bad fields", () => {
    const create = (card: object) => parse({ type: "op", op: { kind: "card.create", opId: "o1", card } });
    expect(create({ id: "c1", x: 0, y: 0, text: "", color: "black" })).toBeNull();
    expect(create({ id: "c 1", x: 0, y: 0, text: "", color: "blue" })).toBeNull();
    expect(create({ id: "c1", x: NaN, y: 0, text: "", color: "blue" })).toBeNull();
    expect(create({ id: "c1", x: 0, y: 0, text: "x".repeat(MAX_TEXT_LENGTH + 1), color: "blue" })).toBeNull();
    expect(
      parse({ type: "op", op: { kind: "card.update", opId: "o1", cardId: "c1", text: "a", baseTextVersion: 1.5 } }),
    ).toBeNull();
    expect(parse({ type: "op", op: { kind: "card.delete", cardId: "c1" } })).toBeNull(); // no opId
  });
});

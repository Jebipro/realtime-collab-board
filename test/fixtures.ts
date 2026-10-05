import type { Op } from "../shared/protocol";

let seq = 0;
const opId = () => `op_${++seq}`;

export const create = (id: string, text = "", x = 0, y = 0): Op => ({
  kind: "card.create",
  opId: opId(),
  card: { id, x, y, text, color: "yellow", authorName: "Tester" },
});
export const update = (cardId: string, text: string, baseTextVersion: number): Op => ({
  kind: "card.update",
  opId: opId(),
  cardId,
  text,
  baseTextVersion,
});
export const move = (cardId: string, x: number, y: number): Op => ({ kind: "card.move", opId: opId(), cardId, x, y });
export const del = (cardId: string): Op => ({ kind: "card.delete", opId: opId(), cardId });

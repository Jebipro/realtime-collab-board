// Pure board state transitions shared by the server (authoritative apply)
// and the client (confirmed apply + optimistic replay of pending ops).

import type { Card, Op, RejectReason } from "./protocol";

/** Cards keyed by id. Key insertion order is the z-order (last = on top). */
export type Cards = Readonly<Record<string, Card>>;

export type ApplyResult =
  | { ok: true; cards: Cards }
  | { ok: false; reason: RejectReason; message: string };

const fail = (reason: RejectReason, message: string): ApplyResult => ({ ok: false, reason, message });

/** Re-inserts a card as the last key so it renders on top. */
function withOnTop(cards: Cards, card: Card): Cards {
  const { [card.id]: _old, ...rest } = cards;
  return { ...rest, [card.id]: card };
}

/**
 * Applies one operation. Never mutates `cards`.
 *
 * Conflict policy:
 * - move: last write wins (in server arrival order), no stale check.
 * - update (text): rejected as `stale` when the card's textVersion no longer
 *   matches the version the editor started from.
 * - delete: always wins; later ops on the card fail with `not_found`.
 */
export function applyOp(cards: Cards, op: Op, by: string, maxCards = Infinity): ApplyResult {
  switch (op.kind) {
    case "card.create": {
      if (Object.hasOwn(cards, op.card.id)) return fail("duplicate_id", "같은 id의 카드가 이미 있습니다.");
      if (Object.keys(cards).length >= maxCards) return fail("limit", "보드의 카드 수 한도에 도달했습니다.");
      const card: Card = { ...op.card, textVersion: 0, createdBy: by };
      return { ok: true, cards: { ...cards, [card.id]: card } };
    }
    case "card.update": {
      const card = Object.hasOwn(cards, op.cardId) ? cards[op.cardId] : undefined;
      if (!card) return fail("not_found", "카드가 이미 삭제되었습니다.");
      if (card.textVersion !== op.baseTextVersion)
        return fail("stale", "다른 사용자가 먼저 이 카드를 수정했습니다.");
      return {
        ok: true,
        cards: { ...cards, [card.id]: { ...card, text: op.text, textVersion: card.textVersion + 1 } },
      };
    }
    case "card.move": {
      const card = Object.hasOwn(cards, op.cardId) ? cards[op.cardId] : undefined;
      if (!card) return fail("not_found", "카드가 이미 삭제되었습니다.");
      return { ok: true, cards: withOnTop(cards, { ...card, x: op.x, y: op.y }) };
    }
    case "card.delete": {
      if (!Object.hasOwn(cards, op.cardId)) return fail("not_found", "카드가 이미 삭제되었습니다.");
      const { [op.cardId]: _removed, ...rest } = cards;
      return { ok: true, cards: rest };
    }
  }
}

export function cardsFromList(list: Card[]): Cards {
  return Object.fromEntries(list.map((c) => [c.id, c]));
}

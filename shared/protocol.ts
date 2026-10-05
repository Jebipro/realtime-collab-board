// Wire protocol shared by server and client.
// Every message is a JSON object with a `type` discriminator.

export const BOARD_WIDTH = 2400;
export const BOARD_HEIGHT = 1600;
export const CARD_WIDTH = 200;
export const CARD_HEIGHT = 120;
export const MAX_TEXT_LENGTH = 500;
export const MAX_NAME_LENGTH = 32;
export const MAX_CARDS_PER_ROOM = 300;
export const CARD_COLORS = ["yellow", "blue", "green", "pink", "purple"] as const;

export type CardColor = (typeof CARD_COLORS)[number];

export interface Card {
  id: string;
  x: number;
  y: number;
  text: string;
  color: CardColor;
  /** Incremented on every accepted text change; used for stale-edit detection. */
  textVersion: number;
  createdBy: string;
  /** Display name at creation; kept on the card so it survives the author leaving. */
  authorName: string;
}

export interface Snapshot {
  revision: number;
  cards: Card[];
}

export interface Participant {
  clientId: string;
  name: string;
}

export type Op =
  | {
      kind: "card.create";
      opId: string;
      card: Pick<Card, "id" | "x" | "y" | "text" | "color" | "authorName">;
    }
  | { kind: "card.update"; opId: string; cardId: string; text: string; baseTextVersion: number }
  | { kind: "card.move"; opId: string; cardId: string; x: number; y: number }
  | { kind: "card.delete"; opId: string; cardId: string };

export type ClientMessage =
  | { type: "join"; roomId: string; clientId: string; name: string }
  | { type: "sync" }
  | { type: "op"; op: Op };

export type RejectReason = "stale" | "not_found" | "invalid" | "duplicate_id" | "limit";

export type ServerMessage =
  | { type: "welcome"; self: Participant; snapshot: Snapshot; participants: Participant[] }
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "op"; revision: number; op: Op; by: string }
  | { type: "reject"; opId: string; reason: RejectReason; message: string }
  | { type: "presence"; participants: Participant[] }
  | { type: "error"; message: string };

// ---------------------------------------------------------------------------
// Validation. Returns a normalized value or null. Used on the server for all
// client input, and on the client defensively for server input.

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isId = (v: unknown): v is string => typeof v === "string" && ID_RE.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_TEXT_LENGTH;

export const clampX = (x: number) => Math.round(Math.min(Math.max(x, 0), BOARD_WIDTH - CARD_WIDTH));
export const clampY = (y: number) => Math.round(Math.min(Math.max(y, 0), BOARD_HEIGHT - CARD_HEIGHT));

export function normalizeName(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const name = v.trim().slice(0, MAX_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export function parseOp(v: unknown): Op | null {
  if (!isObj(v) || !isId(v.opId)) return null;
  switch (v.kind) {
    case "card.create": {
      const c = v.card;
      if (!isObj(c) || !isId(c.id) || !isNum(c.x) || !isNum(c.y) || !isText(c.text)) return null;
      if (!CARD_COLORS.includes(c.color as CardColor)) return null;
      return {
        kind: "card.create",
        opId: v.opId,
        card: {
          id: c.id,
          x: clampX(c.x),
          y: clampY(c.y),
          text: c.text,
          color: c.color as CardColor,
          authorName: normalizeName(c.authorName) ?? "Guest",
        },
      };
    }
    case "card.update":
      if (!isId(v.cardId) || !isText(v.text) || !Number.isInteger(v.baseTextVersion)) return null;
      return {
        kind: "card.update",
        opId: v.opId,
        cardId: v.cardId,
        text: v.text,
        baseTextVersion: v.baseTextVersion as number,
      };
    case "card.move":
      if (!isId(v.cardId) || !isNum(v.x) || !isNum(v.y)) return null;
      return { kind: "card.move", opId: v.opId, cardId: v.cardId, x: clampX(v.x), y: clampY(v.y) };
    case "card.delete":
      if (!isId(v.cardId)) return null;
      return { kind: "card.delete", opId: v.opId, cardId: v.cardId };
    default:
      return null;
  }
}

export function parseClientMessage(raw: string): ClientMessage | null {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "join": {
      const name = normalizeName(v.name);
      if (typeof v.roomId !== "string" || !ROOM_ID_RE.test(v.roomId) || !isId(v.clientId) || !name)
        return null;
      return { type: "join", roomId: v.roomId, clientId: v.clientId, name };
    }
    case "sync":
      return { type: "sync" };
    case "op": {
      const op = parseOp(v.op);
      return op ? { type: "op", op } : null;
    }
    default:
      return null;
  }
}

export function parseServerMessage(raw: string): ServerMessage | null {
  try {
    const v = JSON.parse(raw);
    if (!isObj(v) || typeof v.type !== "string") return null;
    return v as unknown as ServerMessage;
  } catch {
    return null;
  }
}

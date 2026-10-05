// Client-side sync model. Pure functions only; no I/O.
//
//   view = confirmed (server state at `revision`) + pending ops replayed on top
//
// - local op      -> appended to pending, view recomputed (optimistic)
// - server op     -> applied to confirmed; if it is ours, removed from pending (ack)
// - server reject -> removed from pending; view recomputed (= rollback)
// - snapshot      -> confirmed replaced; pending kept and re-sent by the caller

import { applyOp, cardsFromList, type Cards } from "../../shared/board";
import type { Op, RejectReason, Snapshot } from "../../shared/protocol";

export interface PendingOp {
  op: Op;
  /** Whether the op has been written to the current socket. Reset on disconnect. */
  sent: boolean;
  /** Survives disconnect: the server may already have applied this op. */
  attempted?: boolean;
  /** After a snapshot, ambiguous in-flight ops await their receipt before replay. */
  replay?: boolean;
}

export interface SyncState {
  loaded: boolean;
  confirmed: Cards;
  revision: number;
  pending: PendingOp[];
  view: Cards;
  /** Set after a revision gap; incoming ops are skipped until a snapshot arrives. */
  awaitingSnapshot: boolean;
  /** Rejected text is recoverable by the existing card editor, independently of rollback. */
  rejectedEdits: ReadonlyMap<string, Extract<Op, { kind: "card.update" }>>;
}

export const initialSyncState: SyncState = {
  loaded: false,
  confirmed: {},
  revision: 0,
  pending: [],
  view: {},
  awaitingSnapshot: false,
  rejectedEdits: new Map(),
};

/** Replays pending ops over confirmed state. Ops that no longer apply are skipped in the view. */
export function deriveView(confirmed: Cards, pending: PendingOp[], selfId: string): Cards {
  let cards = confirmed;
  for (const p of pending) {
    if (p.replay === false) continue;
    const r = applyOp(cards, p.op, selfId);
    if (r.ok) cards = r.cards;
  }
  return cards;
}

const withPending = (s: SyncState, pending: PendingOp[], selfId: string): SyncState => ({
  ...s,
  pending,
  view: deriveView(s.confirmed, pending, selfId),
  rejectedEdits: new Map([...s.rejectedEdits].filter(([id]) => Object.hasOwn(s.confirmed, id))),
});

export type LocalResult =
  | { ok: true; state: SyncState }
  | { ok: false; reason: RejectReason; message: string };

export function applyLocal(s: SyncState, op: Op, selfId: string): LocalResult {
  const check = applyOp(s.view, op, selfId);
  if (!check.ok) return check;

  let pending = s.pending;
  // Coalesce: a not-yet-sent move of the same card is superseded by this one
  // (keeps the offline queue small during drags).
  const last = pending[pending.length - 1];
  if (op.kind === "card.move" && last && !last.sent && !last.attempted && last.op.kind === "card.move" && last.op.cardId === op.cardId) {
    pending = pending.slice(0, -1);
  }
  const rejectedEdits = new Map(s.rejectedEdits);
  if (op.kind === "card.update" || op.kind === "card.delete") rejectedEdits.delete(op.cardId);
  return { ok: true, state: { ...s, rejectedEdits, pending: [...pending, { op, sent: false }], view: check.cards } };
}

export function markSent(s: SyncState, opIds: ReadonlySet<string>): SyncState {
  if (opIds.size === 0) return s;
  return { ...s, pending: s.pending.map((p) => (opIds.has(p.op.opId) ? { ...p, sent: true, attempted: true } : p)) };
}

export function markAllUnsent(s: SyncState): SyncState {
  return { ...s, pending: s.pending.map((p) => ({ ...p, sent: false })) };
}

export function applySnapshot(s: SyncState, snap: Snapshot, selfId: string): SyncState {
  const confirmed = cardsFromList(snap.cards);
  const pending = s.pending.map((p) => p.attempted ? { ...p, replay: false } : p);
  return {
    ...s,
    loaded: true,
    confirmed,
    pending,
    revision: snap.revision,
    awaitingSnapshot: false,
    view: deriveView(confirmed, pending, selfId),
    rejectedEdits: new Map([...s.rejectedEdits].filter(([id]) => Object.hasOwn(confirmed, id))),
  };
}

export type ServerOpResult = { state: SyncState; needsSync: boolean };

export function applyServerOp(
  s: SyncState,
  msg: { revision: number; op: Op; by: string },
  selfId: string,
): ServerOpResult {
  const isMine = msg.by === selfId && s.pending.some((p) => p.op.opId === msg.op.opId);
  const pending = isMine ? s.pending.filter((p) => p.op.opId !== msg.op.opId) : s.pending;

  // Already reflected in confirmed (duplicate ack after a resend), or we're
  // waiting for a snapshot that will contain it: only settle the pending entry.
  if (msg.revision <= s.revision || s.awaitingSnapshot) {
    return { state: withPending(s, pending, selfId), needsSync: false };
  }
  if (msg.revision !== s.revision + 1) {
    return { state: { ...withPending(s, pending, selfId), awaitingSnapshot: true }, needsSync: true };
  }
  const r = applyOp(s.confirmed, msg.op, msg.by);
  if (!r.ok) {
    // Server accepted something we can't apply: our confirmed copy diverged.
    return { state: { ...withPending(s, pending, selfId), awaitingSnapshot: true }, needsSync: true };
  }
  const confirmed = r.cards;
  return {
    state: { ...withPending({ ...s, confirmed }, pending, selfId), revision: msg.revision },
    needsSync: false,
  };
}

export function applyReject(s: SyncState, opId: string, selfId: string): { state: SyncState; op: Op | null } {
  const entry = s.pending.find((p) => p.op.opId === opId);
  if (!entry) return { state: s, op: null };
  const rejectedEdits = new Map(s.rejectedEdits);
  if (entry.op.kind === "card.update") rejectedEdits.set(entry.op.cardId, entry.op);
  return { state: withPending({ ...s, rejectedEdits }, s.pending.filter((p) => p !== entry), selfId), op: entry.op };
}

/** A card with an unacknowledged text edit can't be edited again until it settles. */
export function hasPendingText(s: SyncState, cardId: string): boolean {
  return s.pending.some((p) => p.op.kind === "card.update" && p.op.cardId === cardId);
}

export function pendingCardIds(s: SyncState): Set<string> {
  const ids = new Set<string>();
  for (const p of s.pending) ids.add(p.op.kind === "card.create" ? p.op.card.id : p.op.cardId);
  return ids;
}

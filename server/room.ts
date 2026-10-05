import { applyOp, type Cards } from "../shared/board";
import {
  MAX_CARDS_PER_ROOM,
  type Op,
  type Participant,
  type ServerMessage,
  type Snapshot,
} from "../shared/protocol";

export type Send = (msg: ServerMessage) => void;

interface Member {
  name: string;
  send: Send;
}

/** How many applied opIds a room remembers for retry de-duplication. */
const OP_HISTORY = 2000;

/**
 * One board. Owns the authoritative card state and the room revision.
 * Transport-agnostic: members are just `send` callbacks.
 */
export class Room {
  private cards: Cards = {};
  private revision = 0;
  /** opId -> revision it was applied at, insertion-ordered for FIFO eviction. */
  private applied = new Map<string, number>();
  private members = new Map<string, Member>();

  constructor(readonly id: string) {}

  get size() {
    return this.members.size;
  }

  snapshot(): Snapshot {
    return { revision: this.revision, cards: Object.values(this.cards) };
  }

  participants(): Participant[] {
    return [...this.members].map(([clientId, m]) => ({ clientId, name: m.name }));
  }

  /**
   * Adds (or replaces, on reconnect with the same clientId) a member.
   * Returns the replaced member's send so the transport can close it.
   */
  join(clientId: string, name: string, send: Send): Send | undefined {
    const previous = this.members.get(clientId)?.send;
    this.members.set(clientId, { name, send });
    send({
      type: "welcome",
      self: { clientId, name },
      snapshot: this.snapshot(),
      participants: this.participants(),
    });
    this.broadcastPresence();
    return previous;
  }

  /** Removes a member only if `send` is still its current connection. */
  leave(clientId: string, send: Send) {
    if (this.members.get(clientId)?.send !== send) return;
    this.members.delete(clientId);
    this.broadcastPresence();
  }

  sync(clientId: string) {
    this.members.get(clientId)?.send({ type: "snapshot", snapshot: this.snapshot() });
  }

  handleOp(clientId: string, op: Op) {
    const member = this.members.get(clientId);
    if (!member) return;

    // A retry of an op we already applied (e.g. ack lost during a disconnect):
    // acknowledge to the sender only, at its original revision, without re-applying.
    const appliedAt = this.applied.get(op.opId);
    if (appliedAt !== undefined) {
      member.send({ type: "op", revision: appliedAt, op, by: clientId });
      return;
    }

    // The server, not the client, decides the author name shown on a card.
    if (op.kind === "card.create") op = { ...op, card: { ...op.card, authorName: member.name } };

    const result = applyOp(this.cards, op, clientId, MAX_CARDS_PER_ROOM);
    if (!result.ok) {
      member.send({ type: "reject", opId: op.opId, reason: result.reason, message: result.message });
      return;
    }

    this.cards = result.cards;
    this.revision += 1;
    this.applied.set(op.opId, this.revision);
    if (this.applied.size > OP_HISTORY) {
      this.applied.delete(this.applied.keys().next().value!);
    }
    this.broadcast({ type: "op", revision: this.revision, op, by: clientId });
  }

  private broadcastPresence() {
    this.broadcast({ type: "presence", participants: this.participants() });
  }

  private broadcast(msg: ServerMessage) {
    for (const m of this.members.values()) m.send(msg);
  }
}

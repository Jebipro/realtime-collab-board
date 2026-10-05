import { useCallback, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  CARD_COLORS,
  CARD_HEIGHT,
  CARD_WIDTH,
  clampX,
  clampY,
  type Card,
} from "../../shared/protocol";
import type { BoardClient, BoardSnapshot } from "../sync/BoardClient";
import { hasPendingText, pendingCardIds } from "../sync/syncState";
import { randomId } from "../util";
import { CardView } from "./CardView";
import { ConnectionBanner, TopBar } from "./TopBar";

export function BoardView({ client, snap, selfName }: { client: BoardClient; snap: BoardSnapshot; selfName: string }) {
  const { sync, connection, participants, notices } = snap;
  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoEditId, setAutoEditId] = useState<string | null>(null);

  const cards = useMemo(() => Object.values(sync.view), [sync.view]);
  const pendingIds = useMemo(() => pendingCardIds(sync), [sync]);

  const createAt = useCallback(
    (x: number, y: number) => {
      const id = randomId("c_");
      const ok = client.submit({
        kind: "card.create",
        opId: randomId("op_"),
        card: {
          id,
          x: clampX(x),
          y: clampY(y),
          text: "",
          color: CARD_COLORS[Math.floor(Math.random() * CARD_COLORS.length)],
          authorName: selfName,
        },
      });
      if (ok) setAutoEditId(id);
    },
    [client, selfName],
  );

  /** Toolbar button: place the card in the middle of what's currently visible, nudged to avoid exact stacking. */
  const createInView = () => {
    const el = scrollRef.current;
    const jitter = () => Math.round((Math.random() - 0.5) * 80);
    const x = el ? el.scrollLeft + el.clientWidth / 2 - CARD_WIDTH / 2 : 80;
    const y = el ? el.scrollTop + el.clientHeight / 2 - CARD_HEIGHT / 2 : 80;
    createAt(x + jitter(), y + jitter());
  };

  const onBoardDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return; // only empty board space
    const rect = e.currentTarget.getBoundingClientRect();
    createAt(e.clientX - rect.left - CARD_WIDTH / 2, e.clientY - rect.top - 24);
  };

  const move = useCallback(
    (cardId: string, x: number, y: number) =>
      client.submit({ kind: "card.move", opId: randomId("op_"), cardId, x: clampX(x), y: clampY(y) }),
    [client],
  );
  const save = useCallback(
    (card: Card, text: string, baseTextVersion: number) =>
      client.submit({ kind: "card.update", opId: randomId("op_"), cardId: card.id, text, baseTextVersion }),
    [client],
  );
  const remove = useCallback(
    (cardId: string) => client.submit({ kind: "card.delete", opId: randomId("op_"), cardId }),
    [client],
  );

  return (
    <div className="app">
      <TopBar
        roomId={client.roomId}
        selfId={client.clientId}
        connection={connection}
        participants={participants}
        pendingCount={sync.pending.length}
        onAddCard={createInView}
        onRetry={() => client.retryNow()}
        canAdd={sync.loaded}
      />
      <ConnectionBanner connection={connection} loaded={sync.loaded} pendingCount={sync.pending.length} />

      <div className="board-scroll" ref={scrollRef}>
        {!sync.loaded ? (
          <div className="board-loading" role="status">
            <div className="spinner" aria-hidden="true" />
            {connection.status === "offline" || connection.status === "error"
              ? "보드를 불러오지 못했습니다. 연결 상태를 확인하세요."
              : "보드를 불러오는 중…"}
          </div>
        ) : (
          <div
            className="board"
            style={{ width: BOARD_WIDTH, height: BOARD_HEIGHT }}
            onDoubleClick={onBoardDoubleClick}
            role="region"
            aria-label={`보드, 카드 ${cards.length}개`}
          >
            {cards.length === 0 && (
              <div className="empty-state">
                <h2>아직 카드가 없습니다</h2>
                <p>
                  상단의 <strong>카드 추가</strong> 버튼을 누르거나 보드의 빈 곳을 더블클릭하세요.
                  <br />
                  같은 주소를 다른 사람에게 공유하면 함께 편집할 수 있습니다.
                </p>
              </div>
            )}
            {cards.map((card) => (
              <CardView
                key={card.id}
                card={card}
                pending={pendingIds.has(card.id)}
                textLocked={hasPendingText(sync, card.id)}
                rejectedEdit={sync.rejectedEdits.get(card.id)}
                autoEdit={autoEditId === card.id}
                onAutoEditConsumed={() => setAutoEditId(null)}
                onMove={move}
                onSave={save}
                onDelete={remove}
              />
            ))}
          </div>
        )}
      </div>

      <div className="notices" role="status" aria-live="polite">
        {notices.map((n) => (
          <div key={n.id} className="notice">
            <span>{n.message}</span>
            <button className="icon-btn" aria-label="알림 닫기" onClick={() => client.dismissNotice(n.id)}>
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

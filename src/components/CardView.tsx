import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { MAX_TEXT_LENGTH, type Card } from "../../shared/protocol";
import { throttle } from "../util";

const DRAG_THRESHOLD = 4;
const DRAG_SEND_MS = 60;
const KEY_STEP = 20;
const KEY_STEP_LARGE = 100;

interface Props {
  card: Card;
  authorName: string;
  /** Has unacknowledged local ops. */
  pending: boolean;
  /** Has an unacknowledged text edit; editing again waits for it to settle. */
  textLocked: boolean;
  autoEdit: boolean;
  onAutoEditConsumed: () => void;
  onMove: (cardId: string, x: number, y: number) => void;
  onSave: (card: Card, text: string, baseTextVersion: number) => void;
  onDelete: (cardId: string) => void;
}

interface Drag {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  x: number;
  y: number;
  moved: boolean;
}

interface Edit {
  draft: string;
  /** textVersion the edit started from; sent as baseTextVersion for stale detection. */
  base: number;
}

export const CardView = memo(function CardView(props: Props) {
  const { card, authorName, pending, textLocked, autoEdit, onAutoEditConsumed, onMove, onSave, onDelete } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);

  const sendMove = useMemo(() => throttle(onMove, DRAG_SEND_MS), [onMove]);
  useEffect(() => () => sendMove.cancel(), [sendMove]);

  const startEdit = () => {
    if (textLocked) return;
    setEdit({ draft: card.text, base: card.textVersion });
  };

  useEffect(() => {
    if (autoEdit) {
      setEdit({ draft: card.text, base: card.textVersion });
      onAutoEditConsumed();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoEdit]);

  useEffect(() => {
    if (edit && textareaRef.current && document.activeElement !== textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    }
  }, [edit !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // Mirrors `edit` synchronously so the blur fired by focusing the card after
  // Esc/save doesn't finish the same edit a second time.
  const editRef = useRef<Edit | null>(null);
  editRef.current = edit;

  const finishEdit = (commit: boolean) => {
    const current = editRef.current;
    if (!current) return;
    const changed = current.draft !== card.text || current.base !== card.textVersion;
    if (commit && changed && current.base !== card.textVersion) {
      // Known stale: saving would be rejected. Keep the editor (and the draft)
      // open; the conflict notice offers to load the latest text.
      textareaRef.current?.focus();
      return;
    }
    editRef.current = null;
    if (commit && changed) onSave(card, current.draft, current.base);
    setEdit(null);
    rootRef.current?.focus();
  };

  // Someone else changed the text while we were editing: saving would be rejected as stale.
  const conflict = edit !== null && card.textVersion !== edit.base;

  // ---- drag (pointer events: mouse, touch, pen) ----

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (edit || e.button !== 0) return;
    if ((e.target as HTMLElement).closest("button, textarea")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDrag({
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: card.x,
      originY: card.y,
      x: card.x,
      y: card.y,
      moved: false,
    });
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
    const next = { ...drag, moved: true, x: drag.originX + dx, y: drag.originY + dy };
    setDrag(next);
    sendMove(card.id, next.x, next.y); // live, throttled: others see the card travel
  };

  const endDrag = (e: PointerEvent<HTMLDivElement>, commit: boolean) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    sendMove.cancel();
    if (drag.moved) onMove(card.id, commit ? drag.x : drag.originX, commit ? drag.y : drag.originY);
    setDrag(null);
  };

  // ---- keyboard ----

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (edit || e.target !== e.currentTarget) return;
    const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const [dx, dy] = moves[e.key];
      onMove(card.id, card.x + dx, card.y + dy);
      // Keep the card in view for keyboard moves only (never for remote moves).
      requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" }));
    } else if (e.key === "Enter") {
      e.preventDefault();
      startEdit();
    } else if (e.key === "Delete") {
      e.preventDefault();
      onDelete(card.id);
    }
  };

  const x = drag?.moved ? drag.x : card.x;
  const y = drag?.moved ? drag.y : card.y;
  const label = card.text.trim() ? card.text.trim().slice(0, 60) : "빈 카드";

  return (
    <div
      ref={rootRef}
      className={`card card-${card.color}${drag?.moved ? " is-dragging" : ""}${edit ? " is-editing" : ""}`}
      style={{ transform: `translate(${x}px, ${y}px)` }}
      tabIndex={0}
      role="group"
      aria-roledescription="카드"
      aria-label={`${label}. 작성자 ${authorName}.${pending ? " 동기화 중." : ""} Enter 편집, 화살표 이동, Delete 삭제`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={(e) => endDrag(e, true)}
      onPointerCancel={(e) => endDrag(e, false)}
      onDoubleClick={(e) => {
        e.stopPropagation();
        if (!edit) startEdit();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="card-head">
        <span className="grip" aria-hidden="true">⠿</span>
        <span className="card-author">{authorName}</span>
        {pending && (
          <span className="card-sync" title="서버 확인 대기 중">
            <span className="sync-dot" aria-hidden="true" />
            동기화 중
          </span>
        )}
        <div className="card-actions">
          {!edit && (
            <button
              className="icon-btn"
              onClick={startEdit}
              disabled={textLocked}
              aria-label="카드 편집"
              title={textLocked ? "이전 편집이 저장되는 중입니다" : "편집 (Enter)"}
            >
              ✎
            </button>
          )}
          <button className="icon-btn" onClick={() => onDelete(card.id)} aria-label="카드 삭제" title="삭제 (Delete)">
            🗑
          </button>
        </div>
      </div>

      {edit ? (
        <div
          className="card-edit"
          onBlur={(e) => {
            // Save when focus leaves the editor (but not when moving between its own
            // controls, or when the whole window/tab loses focus).
            if (!document.hasFocus()) return;
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) finishEdit(true);
          }}
        >
          <textarea
            ref={textareaRef}
            value={edit.draft}
            maxLength={MAX_TEXT_LENGTH}
            aria-label="카드 내용"
            placeholder="내용을 입력하세요"
            onChange={(e) => setEdit({ ...edit, draft: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                finishEdit(false);
              } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                finishEdit(true);
              }
            }}
          />
          {conflict ? (
            <div className="card-conflict" role="alert">
              다른 사용자가 이 카드를 방금 수정했습니다. 지금 저장하면 거부됩니다.
              <button
                className="btn btn-small"
                onClick={() => {
                  setEdit({ draft: card.text, base: card.textVersion });
                  textareaRef.current?.focus();
                }}
              >
                최신 내용 불러오기
              </button>
            </div>
          ) : (
            <div className="card-edit-hint">Ctrl+Enter 저장 · Esc 취소</div>
          )}
        </div>
      ) : (
        <p className={`card-text${card.text.trim() ? "" : " is-empty"}`}>{card.text.trim() ? card.text : "빈 카드 — 더블클릭해서 편집"}</p>
      )}
    </div>
  );
});

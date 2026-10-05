import { useEffect, useState, type CSSProperties } from "react";
import type { Participant } from "../../shared/protocol";
import type { Connection } from "../sync/BoardClient";
import { avatarHue, initials } from "../util";

const STATUS_LABEL: Record<Connection["status"], string> = {
  connecting: "연결 중…",
  connected: "실시간 연결됨",
  reconnecting: "재연결 중…",
  offline: "오프라인",
  error: "연결 오류",
};

function useNow(active: boolean) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ConnectionStatus({ connection, onRetry }: { connection: Connection; onRetry: () => void }) {
  const now = useNow(connection.status === "reconnecting");
  const { status, attempt, maxAttempts, nextRetryAt } = connection;
  let detail = "";
  if (status === "reconnecting") {
    const secs = nextRetryAt ? Math.ceil((nextRetryAt - now) / 1000) : 0;
    detail = secs > 0 ? ` ${secs}초 후 재시도 (${attempt}/${maxAttempts})` : ` 시도 중 (${attempt}/${maxAttempts})`;
  }
  return (
    <div className={`conn conn-${status}`} role="status" aria-live="polite">
      <span className="conn-dot" aria-hidden="true" />
      <span className="conn-label">
        {STATUS_LABEL[status]}
        <span className="conn-detail">{detail}</span>
      </span>
      {(status === "offline" || status === "error" || status === "reconnecting") && (
        <button className="btn btn-small" onClick={onRetry}>
          지금 재시도
        </button>
      )}
    </div>
  );
}

export function TopBar(props: {
  roomId: string;
  selfId: string;
  connection: Connection;
  participants: Participant[];
  pendingCount: number;
  canAdd: boolean;
  onAddCard: () => void;
  onRetry: () => void;
}) {
  const { roomId, selfId, connection, participants, pendingCount, canAdd, onAddCard, onRetry } = props;
  const [copied, setCopied] = useState(false);

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked; the URL bar still has it */
    }
  };

  // Self first, then others in join order.
  const ordered = [...participants].sort((a, b) => Number(b.clientId === selfId) - Number(a.clientId === selfId));

  return (
    <header className="topbar">
      <div className="topbar-left">
        <div className="brand" aria-hidden="true" />
        <div className="room">
          <span className="room-label">Room</span>
          <span className="room-id">{roomId}</span>
        </div>
        <button className="btn btn-ghost btn-small" onClick={copyLink}>
          {copied ? "복사됨" : "링크 복사"}
        </button>
      </div>

      <div className="topbar-right">
        <ConnectionStatus connection={connection} onRetry={onRetry} />
        {pendingCount > 0 && (
          <span className="pending-pill" title="서버 확인을 기다리는 변경">
            동기화 대기 {pendingCount}
          </span>
        )}
        <ul className="avatars" aria-label={`참가자 ${participants.length}명`}>
          {ordered.slice(0, 5).map((p) => (
            <li
              key={p.clientId}
              className={`avatar${p.clientId === selfId ? " avatar-self" : ""}`}
              style={{ "--hue": avatarHue(p.clientId) } as CSSProperties}
              title={p.clientId === selfId ? `${p.name} (나)` : p.name}
            >
              <span aria-hidden="true">{initials(p.name)}</span>
              <span className="sr-only">{p.clientId === selfId ? `${p.name} (나)` : p.name}</span>
            </li>
          ))}
          {ordered.length > 5 && (
            <li className="avatar avatar-more" title={ordered.slice(5).map((p) => p.name).join(", ")}>
              +{ordered.length - 5}
            </li>
          )}
        </ul>
        <button className="btn btn-primary" onClick={onAddCard} disabled={!canAdd}>
          <span aria-hidden="true">＋</span> 카드 추가
        </button>
      </div>
    </header>
  );
}

export function ConnectionBanner({
  connection,
  loaded,
  pendingCount,
}: {
  connection: Connection;
  loaded: boolean;
  pendingCount: number;
}) {
  if (!loaded || connection.status === "connected" || connection.status === "connecting") return null;
  const msg =
    connection.status === "error"
      ? connection.detail ?? "연결 오류가 발생했습니다."
      : connection.status === "offline"
        ? `${connection.detail ?? "오프라인입니다."} 마지막으로 받은 보드를 보여주고 있습니다.`
        : "서버와의 연결이 끊겼습니다. 재연결하는 동안 마지막으로 받은 보드를 보여줍니다.";
  return (
    <div className={`banner banner-${connection.status}`} role="alert">
      <strong>{msg}</strong>
      {connection.status !== "error" && (
        <span>
          {" "}
          변경 사항은 이 탭에 보관되었다가 재연결 시 전송됩니다{pendingCount > 0 ? ` (대기 ${pendingCount}건)` : ""}.
        </span>
      )}
    </div>
  );
}

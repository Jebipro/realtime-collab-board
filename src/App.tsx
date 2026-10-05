import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ROOM_ID_RE, normalizeName } from "../shared/protocol";
import { BoardClient } from "./sync/BoardClient";
import { BoardView } from "./components/BoardView";
import { NameDialog } from "./components/NameDialog";
import { randomId } from "./util";

const NAME_KEY = "collab-board:name";

function readRoomId(): string | null {
  const m = window.location.pathname.match(/^\/room\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  // Anything else: start a fresh room and put it in the URL so it can be shared.
  const id = randomId().slice(0, 8);
  window.history.replaceState(null, "", `/room/${id}`);
  return id;
}

function loadName(): string | null {
  try {
    return normalizeName(localStorage.getItem(NAME_KEY));
  } catch {
    return null;
  }
}

function saveName(name: string) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode: name just isn't remembered */
  }
}

function wsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${window.location.host}/ws`;
}

export function App() {
  const roomId = useMemo(readRoomId, []);
  // One identity per page load: two tabs are two participants, and a
  // duplicated tab never fights over the same session.
  const clientId = useMemo(() => randomId("u_"), []);
  const [name, setName] = useState<string | null>(loadName);

  if (!roomId || !ROOM_ID_RE.test(roomId)) {
    return (
      <main className="fullscreen-message" role="alert">
        <h1>잘못된 room 주소입니다</h1>
        <p>room id는 영문, 숫자, -, _ 로 이루어진 40자 이하여야 합니다.</p>
        <a className="btn btn-primary" href="/">새 보드 만들기</a>
      </main>
    );
  }

  if (!name) {
    return (
      <NameDialog
        roomId={roomId}
        onSubmit={(n) => {
          saveName(n);
          setName(n);
        }}
      />
    );
  }

  return <Session roomId={roomId} clientId={clientId} name={name} />;
}

function Session({ roomId, clientId, name }: { roomId: string; clientId: string; name: string }) {
  const [client, setClient] = useState<BoardClient | null>(null);

  useEffect(() => {
    const c = new BoardClient(roomId, clientId, name, wsUrl());
    setClient(c);
    if (import.meta.env.DEV) (window as unknown as { __board: BoardClient }).__board = c;
    return () => c.dispose();
  }, [roomId, clientId, name]);

  if (!client) return null;
  return <ConnectedBoard client={client} name={name} />;
}

function ConnectedBoard({ client, name }: { client: BoardClient; name: string }) {
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot);
  return <BoardView client={client} snap={snap} selfName={name} />;
}

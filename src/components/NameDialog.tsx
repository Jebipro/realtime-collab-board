import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH, normalizeName } from "../../shared/protocol";

export function NameDialog({ roomId, onSubmit }: { roomId: string; onSubmit: (name: string) => void }) {
  const [guest] = useState(() => `Guest ${Math.floor(1000 + Math.random() * 9000)}`);
  const [value, setValue] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(normalizeName(value) ?? guest);
  };

  return (
    <main className="join-screen">
      <form className="join-card" onSubmit={submit} aria-labelledby="join-title">
        <div className="join-logo" aria-hidden="true" />
        <h1 id="join-title">보드에 참여하기</h1>
        <p className="join-room">
          room <code>{roomId}</code>
        </p>
        <label htmlFor="name-input">표시할 이름</label>
        <input
          id="name-input"
          autoFocus
          maxLength={MAX_NAME_LENGTH}
          placeholder={guest}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="nickname"
        />
        <p className="hint">비워 두면 <strong>{guest}</strong>(으)로 참여합니다. 이 브라우저에 기억됩니다.</p>
        <button type="submit" className="btn btn-primary btn-block">
          참여
        </button>
      </form>
    </main>
  );
}

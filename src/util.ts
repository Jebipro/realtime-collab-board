// Small helpers. Ids avoid crypto.randomUUID so plain-http LAN testing works.

export function randomId(prefix = ""): string {
  let s = "";
  for (let i = 0; i < 12; i++) s += Math.floor(Math.random() * 36).toString(36);
  return prefix + s;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return [...parts[0]].slice(0, 2).join("").toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

const AVATAR_HUES = [12, 38, 145, 190, 220, 265, 300, 340];

/** Stable per-client hue so a person keeps their color across reloads of others' views. */
export function avatarHue(clientId: string): number {
  let h = 0;
  for (const ch of clientId) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_HUES[h % AVATAR_HUES.length];
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastArgs: A | null = null;
  const run = () => {
    timer = null;
    last = Date.now();
    if (lastArgs) fn(...lastArgs);
    lastArgs = null;
  };
  const throttled = (...args: A) => {
    lastArgs = args;
    const wait = ms - (Date.now() - last);
    if (wait <= 0) run();
    else if (!timer) timer = setTimeout(run, wait);
  };
  throttled.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    lastArgs = null;
  };
  return throttled;
}

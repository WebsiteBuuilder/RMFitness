// The little name tag that shows while an entrance jingle plays: "♪ Yugi · Pharaoh's Herald".
// Plain DOM (no re-render of the duel), above the board, never in the way of a tap.
// (its styles are in jingles.css, loaded by main.tsx)

const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (fn: () => void, ms: number) => {
  const t = setTimeout(() => (timers.delete(t), fn()), ms);
  timers.add(t);
};

/** `mine`: the tag sits low, on your empty monster row; else high, on the opponent's. */
export function showJingleToast(who: string, name: string, hue: string, delayMs: number, forMs: number, mine = false) {
  if (typeof document === 'undefined') return;
  later(() => {
    if (document.hidden) return;
    document.querySelectorAll('.jgl-toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = `jgl-toast ${mine ? 'mine' : 'theirs'}`;
    el.setAttribute('role', 'status');
    el.style.setProperty('--jgl-hue', hue);
    const n = document.createElement('i');
    n.textContent = '♪';
    const b = document.createElement('b');
    b.textContent = who;
    const s = document.createElement('span');
    s.textContent = name;
    el.append(n, b, s);
    document.body.appendChild(el);
    // (the opponent's stays a little longer: it steps back while the turn banner passes)
    const stay = mine ? forMs : forMs + 1200;
    later(() => el.classList.add('out'), Math.max(600, stay - 350));
    later(() => el.remove(), stay + 200);
  }, Math.max(0, delayMs));
}

/** Takes every name tag down now, and any still waiting to show (the entrances were cut). */
export function clearJingleToasts() {
  for (const t of timers) clearTimeout(t);
  timers.clear();
  if (typeof document !== 'undefined') document.querySelectorAll('.jgl-toast').forEach((el) => el.remove());
}

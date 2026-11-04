// The little name tag that shows while an entrance jingle plays: "♪ Yugi · Pharaoh's Herald".
// Plain DOM (no re-render of the duel), above the board, never in the way of a tap.
// (its styles are in jingles.css, loaded with the Speed Duel home screen)

export function showJingleToast(who: string, name: string, hue: string, delayMs: number, forMs: number) {
  if (typeof document === 'undefined') return;
  setTimeout(() => {
    if (document.hidden) return;
    document.querySelectorAll('.jgl-toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = 'jgl-toast';
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
    setTimeout(() => el.classList.add('out'), Math.max(600, forMs - 350));
    setTimeout(() => el.remove(), forMs + 200);
  }, Math.max(0, delayMs));
}

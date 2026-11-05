// The frame watchdog behind Performance: Auto. It times the page's own frames; when a phone
// keeps missing them (most frames slower than ~25 fps for several seconds in a row) Lite is
// switched on and stays on for this device (settings.ts), so the game gets smooth by itself.
// It only runs in Auto, only while the page is visible, and stops once Lite is on.
import { getPerf, isLite, noteJank, onArtSettings } from './settings';

/** A frame slower than this counts as missed (a steady 25 fps frame is 40 ms). */
const MISSED_MS = 40;
/** Each judged stretch of play lasts this long... */
const WINDOW_MS = 2000;
/** ...and is "bad" when this share of its time went to missed frames (a few long freezes count as much as steady slowness). */
const BAD_SHARE = 0.35;
/** Bad stretches in a row before Lite switches on (6 s of struggling, not one hiccup). */
const STRIKES = 3;
/** A gap this long is the tab being away or one freeze, not a trend. */
const AWAY_MS = 1000;

let started = false;

export function startPerfGuard() {
  if (started || typeof window === 'undefined' || typeof requestAnimationFrame === 'undefined') return;
  started = true;
  const root = document.documentElement;
  const apply = () => root.classList.toggle('fx-lite', isLite());
  apply();

  let raf = 0;
  let last = 0;
  let winStart = 0;
  let frames = 0;
  let missed = 0;
  let strikes = 0;
  const reset = () => {
    last = 0;
    winStart = 0;
    frames = 0;
    missed = 0;
    strikes = 0;
  };
  const watching = () => !document.hidden && getPerf() === 'auto' && !isLite();

  const tick = (now: number) => {
    raf = 0;
    if (!watching()) return reset();
    if (last) {
      const dt = now - last;
      if (dt > AWAY_MS) {
        reset();
      } else {
        frames++;
        if (dt > MISSED_MS) missed += dt;
      }
    }
    last = now;
    if (!winStart) winStart = now;
    if (now - winStart >= WINDOW_MS) {
      strikes = frames >= 2 && missed / (now - winStart) >= BAD_SHARE ? strikes + 1 : 0;
      winStart = now;
      frames = 0;
      missed = 0;
      if (strikes >= STRIKES) {
        reset();
        if (noteJank()) toast();
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  const wake = () => {
    apply();
    if (!raf && watching()) {
      reset();
      raf = requestAnimationFrame(tick);
    }
  };
  document.addEventListener('visibilitychange', wake);
  onArtSettings(wake);
  wake();
}

/** A short note so the change is not a mystery: what happened and where to undo it. */
function toast() {
  const el = document.createElement('div');
  el.className = 'perf-toast';
  el.setAttribute('role', 'status');
  el.textContent = 'The game was lagging, so Lite graphics are on. Change it in the duel menu under Performance.';
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 5000);
  setTimeout(() => el.remove(), 5600);
}

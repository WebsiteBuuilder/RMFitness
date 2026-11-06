// The frame watchdog behind Performance: Auto. It times the page's own frames; when a phone
// keeps missing them (most frames slower than ~25 fps for several seconds in a row) the quality
// drops one level (Full → Balanced → Lite) and stays there for this device (settings.ts), so the
// game gets smooth by itself. It only runs in Auto, only while the page is visible and something
// is animating anyway (it never keeps a frame loop alive on a still screen), and stops at Lite.
// It also puts the level on <html>: fx-lean (Balanced or Lite) and fx-lite (Lite) for the CSS.
import { LEVEL_NAMES, getPerf, isLite, noteJank, onArtSettings, quality } from './settings';

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
let winStart = 0;
let last = 0;
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
const watching = () => started && !document.hidden && getPerf() === 'auto' && !isLite();

/** One judged stretch is over: three bad ones in a row drop the quality a level. */
function judge(now: number, bad: boolean) {
  strikes = bad ? strikes + 1 : 0;
  winStart = now;
  frames = 0;
  missed = 0;
  if (strikes < STRIKES) return;
  reset();
  const to = noteJank();
  if (to !== null) toast(LEVEL_NAMES[to]);
}

/**
 * Called by the 3D stage on each frame it draws (a cinematic: the heaviest moment, drawn every
 * vsync). The watchdog has no frame loop of its own: a loop that never stops would make the
 * browser run style for every CSS animation on every frame, even on a still screen.
 */
export function noteFrame(now: number) {
  if (!watching()) return reset();
  if (last) {
    const dt = now - last;
    if (dt > AWAY_MS) return void ((last = now), (winStart = now), (frames = 0), (missed = 0));
    frames++;
    if (dt > MISSED_MS) missed += dt;
  }
  last = now;
  if (!winStart) winStart = now;
  if (now - winStart >= WINDOW_MS) judge(now, frames >= 2 && missed / (now - winStart) >= BAD_SHARE);
}

export function startPerfGuard() {
  if (started || typeof window === 'undefined') return;
  started = true;
  const root = document.documentElement;
  const apply = () => (root.classList.toggle('fx-lite', isLite()), root.classList.toggle('fx-lean', quality() < 2));
  apply();
  onArtSettings(apply);
  document.addEventListener('visibilitychange', reset);
  // Outside cinematics: long tasks (the page frozen 50 ms or more at a time) tell the same story
  // without any frame loop. A stretch is bad when long tasks fill BAD_SHARE of it.
  if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes('longtask')) return;
  let blocked = 0;
  let from = 0;
  new PerformanceObserver((list) => {
    if (!watching()) return void ((blocked = 0), (from = 0));
    for (const e of list.getEntries()) {
      if (!from || e.startTime - from > WINDOW_MS * 2) ((from = e.startTime), (blocked = 0));
      blocked += e.duration;
      if (e.startTime + e.duration - from >= WINDOW_MS) {
        const bad = blocked / (e.startTime + e.duration - from) >= BAD_SHARE;
        from = 0;
        blocked = 0;
        judge(performance.now(), bad);
      }
    }
  }).observe({ type: 'longtask', buffered: false });
}

/** A short note so the change is not a mystery: what happened and where to undo it. */
function toast(level: string) {
  const el = document.createElement('div');
  el.className = 'perf-toast';
  el.setAttribute('role', 'status');
  el.textContent = `The game was lagging, so graphics are now ${level}. Change it in the duel menu under Performance.`;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 5000);
  setTimeout(() => el.remove(), 5600);
}

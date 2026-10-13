// Starts downloading the 3D engine (three.js, the director, the field figures)
// early, while the player is still in the Speed Duel hub, the deck screen or the
// duel lobby, so the duel's first cinematic never waits for the download. Cheap to
// call often: it fetches once, in an idle moment, and not at all with cinematics off.
import { getCinematics } from './settings';

let started: Promise<unknown> | null = null;

export function preloadArt3d() {
  if (started || typeof window === 'undefined' || getCinematics() === 'off') return;
  const go = () => {
    started ??= Promise.all([import('./runtime'), import('./board')]).catch(() => {
      started = null; // try again next time (offline, say)
    });
  };
  started = new Promise<void>((ok) => {
    const w = window as Window & { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => number };
    const run = () => {
      started = null;
      go();
      ok();
    };
    if (w.requestIdleCallback) w.requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 300);
  });
}

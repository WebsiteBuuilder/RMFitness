// Shared moments of the Speed Duel screen that other parts must wait on (no imports, so the
// board's flights, the computer's pacing and the tests can read them):
//   the face-off intro still on screen (./faceoff), and
//   your Draw Phase card held back for your swipe (./heartDraw).

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

let introEnd = 0;
/** ms left of the face-off on screen (0 when none is playing). */
export const introLeft = () => Math.max(0, introEnd - now());
/** the face-off is on screen for `ms` more (0: it is gone) */
export function setIntroFor(ms: number) {
  introEnd = ms > 0 ? now() + ms : 0;
}

/**
 * Runs `f` once the face-off has `left` ms or less to go (at once if none is playing; sooner when it
 * is skipped). Returns a cancel function.
 */
export function whenIntroAt(left: number, f: () => void): () => void {
  if (introLeft() <= left) {
    f();
    return () => {};
  }
  const t = setInterval(() => {
    if (introLeft() > left) return;
    clearInterval(t);
    f();
  }, 60);
  return () => clearInterval(t);
}

let held: number | null = null;
/** the card held back from your hand right now (the board's flights leave it alone) */
export const drawHeld = (uid: number) => held === uid;
export function setDrawHeld(uid: number | null) {
  held = uid;
}

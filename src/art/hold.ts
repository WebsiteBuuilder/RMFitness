// A field figure waits while its card is still flying onto the field (src/ui/flights.ts):
// the figure rises as the card lands, not before. Kept free of three.js so the duel
// screen can import it without pulling the 3D engine into the main bundle.
const held = new Map<number, number>();

/** Monster `uid`'s figure stays hidden until `until` (performance.now() time). */
export function holdFigure(uid: number, until: number): void {
  held.set(uid, until);
  if (held.size > 32) held.delete(held.keys().next().value!);
}

/** Is monster `uid`'s figure held back at `now`? */
export function figureHeld(uid: number, now: number): boolean {
  const t = held.get(uid);
  if (t === undefined) return false;
  if (now < t) return true;
  held.delete(uid);
  return false;
}

// A press on the duel screen: for a moment the figures and the art loader stand back,
// so what the tap opens is painted first.
let pressAt = -1e9;
if (typeof window !== 'undefined') window.addEventListener('pointerdown', () => (pressAt = performance.now()), { capture: true, passive: true });

let hushUntil = 0;
/** Something on screen needs the phone to itself for `ms` (the opening deal): loading waits. */
export function hush(ms: number): void {
  hushUntil = Math.max(hushUntil, performance.now() + ms);
}

/** Did a finger go down in the last 300 ms (or is the screen hushed)? */
export function pressQuiet(now: number = performance.now()): boolean {
  return now - pressAt < 300 || now < hushUntil;
}

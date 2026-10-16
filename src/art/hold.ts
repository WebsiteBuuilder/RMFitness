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

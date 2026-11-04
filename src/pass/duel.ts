// The Duel Pass in a duel: each side's title and name plate, for the face-off. Set by the duel
// screen from the seats (a title or plate the other phone sent is only shown if this game knows it).
import { knownPlate, knownTitle } from './pass';

export interface DuelBadge {
  title: string | null;
  plate: string | null;
}
let shown: [DuelBadge | null, DuelBadge | null] | null = null;

const clean = (b: { t?: string; p?: string } | null | undefined): DuelBadge | null => {
  if (!b) return null;
  const title = knownTitle(b.t) ? b.t : null;
  const plate = knownPlate(b.p) ? b.p : null;
  return title || plate ? { title, plate } : null;
};

/** The duel's two sides' badges (null: not a Speed Duel, or no duel). */
export function showDuelBadges(b: [{ t?: string; p?: string } | null, { t?: string; p?: string } | null] | null) {
  shown = b ? [clean(b[0]), clean(b[1])] : null;
}
export const duelBadge = (side: 0 | 1): DuelBadge | null => shown?.[side] ?? null;

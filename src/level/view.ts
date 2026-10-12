// Which rarity each card picture shows right now. Outside a duel, the Speed Duel
// screens show the active profile's own meters. In a duel, each card shows its
// owner's rarity (sent with the deck when they readied), so your brother sees
// your Ultra Rares too.
import type { Pid } from '../eds/types';
import { tierIndex } from './leveling';
import './level.css';

let profileXp: Record<string, number> | null = null;
let duelTiers: [Record<string, number>, Record<string, number>] | null = null;

/** The Speed Duel hub calls this while it is on screen (null to stop). */
export function showProfileLevels(xp: Record<string, number> | null) {
  profileXp = xp;
}

/** The duel screen calls this with each seat's rarity map (null to stop). */
export function showDuelRarity(tiers: [Record<string, number> | undefined, Record<string, number> | undefined] | null) {
  duelTiers = tiers ? [tiers[0] ?? {}, tiers[1] ?? {}] : null;
}

/** The rarity tier index to draw on a card picture (0 = plain). */
export function rarityFor(name: string, owner?: Pid): number {
  if (!name) return 0;
  if (duelTiers) return owner === undefined ? 0 : duelTiers[owner][name] ?? 0;
  return profileXp ? tierIndex(profileXp[name] ?? 0) : 0;
}

/** The active profile's meter for a card, or null outside the Speed Duel screens. */
export function profileXpOf(name: string): number | null {
  return profileXp && !duelTiers ? profileXp[name] ?? 0 : null;
}

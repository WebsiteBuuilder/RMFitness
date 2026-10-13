// Pack finishes: every card pulled from a pack rolls the rarity it comes out at, on the
// card-leveling ladder (Normal, Rare, Super Rare, Ultra Rare, Glossy, Royal, Overframe).
// The odds are fixed and shown on the packs. A card never comes out below the rarity
// its set prints it at, and a pull lifts the card's rarity meter to at least the tier
// it came out at (a card already sitting higher keeps its rarity).
// Rolls come from the pack's seed, so the same pack always comes out the same.
import { rng } from '../eds/rng';
import type { SpeedSave } from '../eds/speedSave';
import { TIERS, cardLevels, tierIndex } from '../level/leveling';
import { PACK_SIZE, rarityIn, type Rarity } from './sets';

/** Each card's finish odds, in parts per 10,000, by TIERS index (N, R, SR, UR, Glossy, Royal, Overframe). */
export const FINISH_ODDS = [5000, 2800, 1300, 600, 200, 75, 25];

/** The lowest finish a card comes out at, from the rarity its set prints it at. */
export const PRINTED_FLOOR: Record<Rarity, number> = { Common: 0, Rare: 1, 'Super Rare': 2, 'Ultra Rare': 3, 'Secret Rare': 3 };

/** Rolls one card's finish (a TIERS index), never below `floor`. */
export function rollFinish(next: () => number, floor = 0): number {
  let roll = next() * 10000;
  let tier = 0;
  for (let i = 0; i < FINISH_ODDS.length; i++) {
    if (roll < FINISH_ODDS[i]) {
      tier = i;
      break;
    }
    roll -= FINISH_ODDS[i];
  }
  return Math.max(floor, tier);
}

/** The finish of every card of a pack, from the pack's seed. */
export function rollFinishes(setName: string | undefined, cards: string[], seed: number): number[] {
  const next = rng((seed ^ 0x9e3779b9) >>> 0);
  return cards.map((n) => rollFinish(next, PRINTED_FLOOR[rarityIn(setName, n)] ?? 0));
}

/** Lifts each pulled card's rarity meter to at least the tier it came out at. */
export function withFinishes(s: SpeedSave, cards: string[], finishes: number[]): SpeedSave {
  const levels = { ...cardLevels(s) };
  let changed = false;
  cards.forEach((n, i) => {
    const t = finishes[i] ?? 0;
    if (t > 0 && tierIndex(levels[n] ?? 0) < t) {
      levels[n] = TIERS[t].at;
      changed = true;
    }
  });
  return changed ? ({ ...s, levels } as SpeedSave) : s;
}

export interface OddsRow {
  tier: number;
  name: string;
  /** chance a single card comes out at exactly this finish (before the printed-rarity floor), in percent */
  perCard: number;
  /** chance a pack has at least one card at this finish or better, in percent */
  perPack: number;
  /** about 1 in this many packs has at least one card at this finish or better */
  oneIn: number;
}

/** The odds table shown on the packs, rarest last. */
export function oddsTable(): OddsRow[] {
  return FINISH_ODDS.map((w, tier) => {
    const orBetter = FINISH_ODDS.slice(tier).reduce((a, b) => a + b, 0) / 10000;
    const perPack = 1 - Math.pow(1 - orBetter, PACK_SIZE);
    return { tier, name: TIERS[tier].name, perCard: w / 100, perPack: Math.round(perPack * 1000) / 10, oneIn: Math.max(1, Math.round(1 / perPack)) };
  });
}

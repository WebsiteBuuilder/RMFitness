// Card sleeves: the back every face-down card of a duelist shows (their deck, their hand as the
// other player sees it, their Set cards, cards in flight). Each player picks theirs on the
// Sleeves page; the other phone sees it in Link Battles (it rides the room's JOIN, like the Ace).
// Purely for show: a sleeve never changes a duel.
//
// How they're had: a few are free, some cost Duel Chips (bought like Mates), and the best are
// earned: Ranked tiers reached, Set Stamps claimed, a full Ace bond, Duel School. Nothing a
// Practice duel, an "Anything goes" deck or a one-phone win against yourself can reach.
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import { chipsOf } from '../collection/economy';
import { stampCards } from '../collection/stamps';
import { lessonsDone, LESSONS } from '../eds/tutorial';
import { RANKED_TIERS, tierIndexOf } from '../eds/speedCampaign/ranked';
import { bondLevel, MAX_BOND } from '../ace/ace';
import { SLEEVES, isSleeve, DEFAULT_SLEEVE, type SleeveDef, type SleeveId } from './roster';

export * from './roster';
export * from './duel';
export { sleeveUrl } from './art';

const BY_ID = new Map(SLEEVES.map((s) => [s.id, s]));

type SleeveSave = SpeedSave & {
  /** the sleeve this duelist's cards wear */
  sleeve?: string;
  /** sleeves bought with Duel Chips */
  sleeves?: string[];
};

/** The highest Ranked tier index this duelist ever reached (any season; -1: never played). */
export function bestRankedTier(solo: SoloSave | null | undefined): number {
  const r = solo?.ranked;
  if (!r) return -1;
  const peaks = [r.peak, r.step, ...(r.history ?? []).map((h) => h.peak)].filter((n) => typeof n === 'number' && Number.isFinite(n));
  return peaks.length ? Math.max(...peaks.map(tierIndexOf)) : -1;
}
/** Set Stamps claimed over every set. */
export const stampsClaimed = (s: SpeedSave) => stampCards(s).reduce((n, c) => n + c.claimed, 0);
/** The best Ace bond level over every card. */
export const bestBond = (s: SpeedSave) => Math.max(0, ...Object.values(s.aceWins ?? {}).map((w) => bondLevel(Math.max(0, Math.floor(w || 0)))));

/** Has this duelist got the sleeve (free ones and reached milestones count without buying)? */
export function hasSleeve(s: SpeedSave, id: SleeveId, solo?: SoloSave | null): boolean {
  const d = BY_ID.get(id);
  if (!d) return false;
  const c = d.cost;
  if ('free' in c) return true;
  if ('chips' in c) return !!(s as SleeveSave).sleeves?.includes(id);
  if ('ranked' in c) return bestRankedTier(solo) >= RANKED_TIERS.findIndex((t) => t.id === c.ranked);
  if ('stamps' in c) return stampsClaimed(s) >= c.stamps;
  if ('bond' in c) return bestBond(s) >= MAX_BOND;
  return lessonsDone(s).length >= LESSONS.length;
}

/** The sleeve this duelist's cards wear (one they no longer have falls back to the Classic Vortex). */
export function chosenSleeve(s: SpeedSave | null | undefined, solo?: SoloSave | null): SleeveId {
  const id = (s as SleeveSave | null | undefined)?.sleeve;
  return s && isSleeve(id) && hasSleeve(s, id, solo) ? id : DEFAULT_SLEEVE;
}

/** What it takes to get a sleeve, said for its card. */
export function sleeveCostNote(s: SpeedSave, d: SleeveDef, solo?: SoloSave | null): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `${c.chips} Duel Chips`;
  if ('ranked' in c) return `Reach ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? c.ranked} in Ranked${bestRankedTier(solo) >= 0 ? ` (best: ${RANKED_TIERS[bestRankedTier(solo)].name})` : ''}`;
  if ('stamps' in c) return `Claim ${c.stamps} Set Stamps (${Math.min(stampsClaimed(s), c.stamps)}/${c.stamps})`;
  if ('bond' in c) return `Take an Ace to bond ${MAX_BOND} (best: ${bestBond(s)})`;
  return `Finish Duel School (${lessonsDone(s).length}/${LESSONS.length})`;
}
/** How far along an earned sleeve is ([have, need]; null for free and Duel Chip ones). */
export function sleeveProgress(s: SpeedSave, d: SleeveDef, solo?: SoloSave | null): [number, number] | null {
  const c = d.cost;
  if ('ranked' in c) {
    const need = RANKED_TIERS.findIndex((t) => t.id === c.ranked);
    return [Math.min(need, Math.max(0, bestRankedTier(solo))), need];
  }
  if ('stamps' in c) return [Math.min(stampsClaimed(s), c.stamps), c.stamps];
  if ('bond' in c) return [Math.min(bestBond(s), MAX_BOND), MAX_BOND];
  if ('school' in c) return [Math.min(lessonsDone(s).length, LESSONS.length), LESSONS.length];
  return null;
}

/** The short version for a grid tile. */
export function sleeveCostShort(d: SleeveDef): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `${c.chips} chips`;
  if ('ranked' in c) return `Ranked ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? ''}`;
  if ('stamps' in c) return `${c.stamps} Stamps`;
  if ('bond' in c) return `Ace bond ${MAX_BOND}`;
  return 'Duel School';
}

/** Why a sleeve can't be bought right now (null: it can). */
export function cantBuySleeve(s: SpeedSave, id: SleeveId): string | null {
  const d = BY_ID.get(id);
  if (!d || !('chips' in d.cost)) return 'This sleeve is earned, not bought';
  if (hasSleeve(s, id)) return 'Already yours';
  if (chipsOf(s) < d.cost.chips) return `Needs ${d.cost.chips} Duel Chips (you have ${chipsOf(s)})`;
  return null;
}

/** Buys a sleeve with Duel Chips (null: can't). */
export function buySleeve(s: SpeedSave, id: SleeveId): SpeedSave | null {
  if (cantBuySleeve(s, id)) return null;
  const price = (BY_ID.get(id)!.cost as { chips: number }).chips;
  const ss = s as SleeveSave;
  return { ...ss, chips: chipsOf(s) - price, sleeves: [...(ss.sleeves ?? []), id] } as SpeedSave;
}

/** Puts a sleeve on this duelist's cards (only one they have). */
export function pickSleeve(s: SpeedSave, id: SleeveId, solo?: SoloSave | null): SpeedSave | null {
  return hasSleeve(s, id, solo) ? ({ ...(s as SleeveSave), sleeve: id } as SpeedSave) : null;
}

/** The famous duelists' own sleeves (matched on a word of their name). */
const NAMED: [RegExp, SleeveId][] = [
  [/\b(yugi|atem|pharaoh)\b/i, 'wdjat'],
  [/\bkaiba\b/i, 'duelist'],
  [/\b(joey|wheeler)\b/i, 'crimson'],
  [/\bpegasus\b/i, 'holo'],
  [/\b(ishizu|odion|shadi)\b/i, 'pharaoh'],
  [/\b(marik|malik)\b/i, 'shadowrealm'],
  [/\bbakura\b/i, 'dark'],
  [/\bmai\b/i, 'wind'],
  [/\b(tea|téa)\b/i, 'soul'],
  [/\b(tristan|rex|bandit)\b/i, 'earth'],
  [/\b(mako)\b/i, 'water'],
  [/\b(weevil|keith)\b/i, 'chrome'],
];
/** A computer duelist's sleeve: their own for the famous ones, else the same one every time for the same name. */
export function sleeveForName(name: string): SleeveId {
  for (const [re, id] of NAMED) if (re.test(name)) return id;
  let h = 11;
  for (const ch of name) h = (h * 33 + ch.charCodeAt(0)) >>> 0;
  return SLEEVES[h % SLEEVES.length].id;
}

/** A sleeve as it rides a room's JOIN from the other phone: a known id, else none. */
export const sleeveFromWire = (v: unknown): SleeveId | null => (isSleeve(v) ? v : null);


// Entrance jingles: which ones a duelist has, picking and buying them, the computer duelists' own,
// and the jingles of the duel on screen (each seat's rides the room's JOIN, like the sleeve).
// Purely for show: a jingle never changes a duel. How they're had mirrors sleeves: a few free,
// some for Duel Chips, the best earned (Ranked tiers, Set Stamps, a full Ace bond, Duel School).
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import type { Pid } from '../eds/types';
import { chipsOf } from '../collection/economy';
import { lessonsDone, LESSONS } from '../eds/tutorial';
import { RANKED_TIERS } from '../eds/speedCampaign/ranked';
import { MAX_BOND } from '../ace/ace';
import { bestBond, bestRankedTier, stampsClaimed } from '../sleeves/sleeves';
import { DEFAULT_JINGLE, isJingle, JINGLES, type JingleDef, type JingleId } from './roster';

export * from './roster';

const BY_ID = new Map(JINGLES.map((j) => [j.id, j]));

type JingleSave = SpeedSave & {
  /** the entrance jingle this duelist plays */
  jingle?: string;
  /** jingles bought with Duel Chips */
  jingles?: string[];
};

/** Has this duelist got the jingle (free ones and reached milestones count without buying)? */
export function hasJingle(s: SpeedSave, id: JingleId, solo?: SoloSave | null): boolean {
  const d = BY_ID.get(id);
  if (!d) return false;
  const c = d.cost;
  if ('free' in c) return true;
  if ('chips' in c) return !!(s as JingleSave).jingles?.includes(id);
  if ('ranked' in c) return bestRankedTier(solo) >= RANKED_TIERS.findIndex((t) => t.id === c.ranked);
  if ('stamps' in c) return stampsClaimed(s) >= c.stamps;
  if ('bond' in c) return bestBond(s) >= MAX_BOND;
  return lessonsDone(s).length >= LESSONS.length;
}

/** The jingle this duelist plays (one they no longer have falls back to Duelist's Call). */
export function chosenJingle(s: SpeedSave | null | undefined, solo?: SoloSave | null): JingleId {
  const id = (s as JingleSave | null | undefined)?.jingle;
  return s && isJingle(id) && hasJingle(s, id, solo) ? id : DEFAULT_JINGLE;
}

/** What it takes to get a jingle, said in full. */
export function jingleCostNote(s: SpeedSave, d: JingleDef, solo?: SoloSave | null): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `${c.chips} Duel Chips`;
  if ('ranked' in c) return `Reach ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? c.ranked} in Ranked${bestRankedTier(solo) >= 0 ? ` (best: ${RANKED_TIERS[bestRankedTier(solo)].name})` : ''}`;
  if ('stamps' in c) return `Claim ${c.stamps} Set Stamps (${Math.min(stampsClaimed(s), c.stamps)}/${c.stamps})`;
  if ('bond' in c) return `Take an Ace to bond ${MAX_BOND} (best: ${bestBond(s)})`;
  return `Finish Duel School (${lessonsDone(s).length}/${LESSONS.length})`;
}

/** The short version for a list row. */
export function jingleCostShort(d: JingleDef): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `● ${c.chips}`;
  if ('ranked' in c) return `Ranked ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? ''}`;
  if ('stamps' in c) return `${c.stamps} Stamps`;
  if ('bond' in c) return `Ace bond ${MAX_BOND}`;
  return 'Duel School';
}

/** Why a jingle can't be bought right now (null: it can). */
export function cantBuyJingle(s: SpeedSave, id: JingleId): string | null {
  const d = BY_ID.get(id);
  if (!d || !('chips' in d.cost)) return 'This jingle is earned, not bought';
  if (hasJingle(s, id)) return 'Already yours';
  if (chipsOf(s) < d.cost.chips) return `Needs ${d.cost.chips} Duel Chips (you have ${chipsOf(s)})`;
  return null;
}

/** Buys a jingle with Duel Chips (null: can't). */
export function buyJingle(s: SpeedSave, id: JingleId): SpeedSave | null {
  if (cantBuyJingle(s, id)) return null;
  const price = (BY_ID.get(id)!.cost as { chips: number }).chips;
  const js = s as JingleSave;
  return { ...js, chips: chipsOf(s) - price, jingles: [...(js.jingles ?? []), id] } as SpeedSave;
}

/** Makes a jingle this duelist's entrance (only one they have). */
export function pickJingle(s: SpeedSave, id: JingleId, solo?: SoloSave | null): SpeedSave | null {
  return hasJingle(s, id, solo) ? ({ ...(s as JingleSave), jingle: id } as SpeedSave) : null;
}

/** The famous duelists' own entrances (matched on a word of their name). */
const NAMED: [RegExp, JingleId][] = [
  [/\b(yugi|atem|pharaoh)\b/i, 'pharaoh'],
  [/\bkaiba\b/i, 'dragon'],
  [/\b(joey|wheeler)\b/i, 'challenge'],
  [/\bpegasus\b/i, 'toon'],
  [/\b(ishizu|odion|shadi)\b/i, 'pharaoh'],
  [/\b(marik|malik|bakura)\b/i, 'shadowgame'],
  [/\b(mai)\b/i, 'star'],
  [/\b(tea|téa)\b/i, 'destiny'],
  [/\b(weevil|keith|bandit)\b/i, 'gear'],
  [/\b(mahad|magician)\b/i, 'magic'],
];
/** A computer duelist's entrance: their own for the famous ones, else the same one every time for the same name. */
export function jingleForName(name: string): JingleId {
  for (const [re, id] of NAMED) if (re.test(name)) return id;
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return JINGLES[h % JINGLES.length].id;
}

/** A jingle as it rides a room's JOIN from the other phone: a known id, else none. */
export const jingleFromWire = (v: unknown): JingleId | null => (isJingle(v) ? v : null);

// ---------- the duel on screen ----------
let duelJingles: [JingleId | null, JingleId | null] = [null, null];
/** The duel screen calls this with each side's entrance (null: none). */
export function showDuelJingles(j: [JingleId | null | undefined, JingleId | null | undefined] | null) {
  duelJingles = j ? [j[0] ?? null, j[1] ?? null] : [null, null];
}
/** A side's entrance in the duel on screen (null: none). */
export function duelJingleOf(side: Pid): JingleId | null {
  return duelJingles[side];
}

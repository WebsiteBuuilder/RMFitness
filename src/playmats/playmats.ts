// Playmats: the picture under a duelist's half of the field. Each player picks theirs on the
// Playmats page; the other phone sees it on their half in Link Battles (it rides the room's JOIN,
// like the sleeve). Purely for show: a mat never changes a duel.
//
// How they're had (the same ways as sleeves): a few free, some for Duel Chips, the best earned
// through Ranked tiers, Set Stamps, a full Ace bond and Duel School. Nothing a Practice duel, an
// "Anything goes" deck or a one-phone win against yourself can reach.
import type { SpeedSave } from '../eds/speedSave';
import type { SoloSave } from '../eds/speedCampaign/save';
import { chipsOf } from '../collection/economy';
import { lessonsDone, LESSONS } from '../eds/tutorial';
import { RANKED_TIERS } from '../eds/speedCampaign/ranked';
import { MAX_BOND } from '../ace/ace';
import { bestBond, bestRankedTier, stampsClaimed } from '../sleeves/sleeves';
import { PLAYMATS, isPlaymat, DEFAULT_PLAYMAT, type PlaymatDef, type PlaymatId } from './roster';

export * from './roster';
export * from './duel';

const BY_ID = new Map(PLAYMATS.map((m) => [m.id, m]));

type MatSave = SpeedSave & {
  /** the mat under this duelist's half */
  playmat?: string;
  /** mats bought with Duel Chips */
  playmats?: string[];
};

/** Has this duelist got the mat (free ones and reached milestones count without buying)? */
export function hasPlaymat(s: SpeedSave, id: PlaymatId, solo?: SoloSave | null): boolean {
  const d = BY_ID.get(id);
  if (!d) return false;
  const c = d.cost;
  if ('free' in c) return true;
  if ('chips' in c) return !!(s as MatSave).playmats?.includes(id);
  if ('ranked' in c) return bestRankedTier(solo) >= RANKED_TIERS.findIndex((t) => t.id === c.ranked);
  if ('stamps' in c) return stampsClaimed(s) >= c.stamps;
  if ('bond' in c) return bestBond(s) >= MAX_BOND;
  return lessonsDone(s).length >= LESSONS.length;
}

/** The mat under this duelist's half (one they no longer have falls back to Tournament Blue). */
export function chosenPlaymat(s: SpeedSave | null | undefined, solo?: SoloSave | null): PlaymatId {
  const id = (s as MatSave | null | undefined)?.playmat;
  return s && isPlaymat(id) && hasPlaymat(s, id, solo) ? id : DEFAULT_PLAYMAT;
}

/** What it takes to get a mat, said for its card. */
export function playmatCostNote(s: SpeedSave, d: PlaymatDef, solo?: SoloSave | null): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `${c.chips} Duel Chips`;
  if ('ranked' in c) return `Reach ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? c.ranked} in Ranked${bestRankedTier(solo) >= 0 ? ` (best: ${RANKED_TIERS[bestRankedTier(solo)].name})` : ''}`;
  if ('stamps' in c) return `Claim ${c.stamps} Set Stamps (${Math.min(stampsClaimed(s), c.stamps)}/${c.stamps})`;
  if ('bond' in c) return `Take an Ace to bond ${MAX_BOND} (best: ${bestBond(s)})`;
  return `Finish Duel School (${lessonsDone(s).length}/${LESSONS.length})`;
}
/** How far along an earned mat is ([have, need]; null for free and Duel Chip ones). */
export function playmatProgress(s: SpeedSave, d: PlaymatDef, solo?: SoloSave | null): [number, number] | null {
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
export function playmatCostShort(d: PlaymatDef): string {
  const c = d.cost;
  if ('free' in c) return 'Free';
  if ('chips' in c) return `${c.chips} chips`;
  if ('ranked' in c) return `Ranked ${RANKED_TIERS.find((t) => t.id === c.ranked)?.name ?? ''}`;
  if ('stamps' in c) return `${c.stamps} Stamps`;
  if ('bond' in c) return `Ace bond ${MAX_BOND}`;
  return 'Duel School';
}

/** Why a mat can't be bought right now (null: it can). */
export function cantBuyPlaymat(s: SpeedSave, id: PlaymatId): string | null {
  const d = BY_ID.get(id);
  if (!d || !('chips' in d.cost)) return 'This playmat is earned, not bought';
  if (hasPlaymat(s, id)) return 'Already yours';
  if (chipsOf(s) < d.cost.chips) return `Needs ${d.cost.chips} Duel Chips (you have ${chipsOf(s)})`;
  return null;
}
/** Buys a mat with Duel Chips (null: can't). */
export function buyPlaymat(s: SpeedSave, id: PlaymatId): SpeedSave | null {
  if (cantBuyPlaymat(s, id)) return null;
  const price = (BY_ID.get(id)!.cost as { chips: number }).chips;
  const ms = s as MatSave;
  return { ...ms, chips: chipsOf(s) - price, playmats: [...(ms.playmats ?? []), id] } as SpeedSave;
}
/** Lays a mat under this duelist's half (only one they have). */
export function pickPlaymat(s: SpeedSave, id: PlaymatId, solo?: SoloSave | null): SpeedSave | null {
  return hasPlaymat(s, id, solo) ? ({ ...(s as MatSave), playmat: id } as SpeedSave) : null;
}

/** The famous duelists' own mats (matched on a word of their name). */
const NAMED: [RegExp, PlaymatId][] = [
  [/\b(yugi|atem|pharaoh)\b/i, 'millennium'],
  [/\bkaiba\b/i, 'dome'],
  [/\b(joey|wheeler)\b/i, 'city'],
  [/\bpegasus\b/i, 'castle'],
  [/\b(ishizu|odion|shadi)\b/i, 'tomb'],
  [/\b(marik|malik)\b/i, 'shadowrealm'],
  [/\bbakura\b/i, 'dark'],
  [/\bmai\b/i, 'wind'],
  [/\b(tea|téa)\b/i, 'heart'],
  [/\b(weevil|keith)\b/i, 'disk'],
  [/\b(tristan|rex)\b/i, 'earth'],
  [/\b(mako)\b/i, 'water'],
  [/\b(mokuba)\b/i, 'blue'],
];
/** Mats an unnamed computer duelist can bring: never one a player has to earn. */
const EVERYDAY = PLAYMATS.filter((m) => 'free' in m.cost || 'chips' in m.cost);
const forName = new Map<string, PlaymatId>();
/** A computer duelist's mat: their own for the famous ones, else the same everyday mat every time for the same name. */
export function playmatForName(name: string): PlaymatId {
  let id = forName.get(name);
  if (id) return id;
  id = NAMED.find(([re]) => re.test(name))?.[1];
  if (!id) {
    let h = 7;
    for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    id = EVERYDAY[h % EVERYDAY.length].id;
  }
  forName.set(name, id);
  return id;
}

/** A mat as it rides a room's JOIN from the other phone: a known id, else none. */
export const playmatFromWire = (v: unknown): PlaymatId | null => (isPlaymat(v) ? v : null);

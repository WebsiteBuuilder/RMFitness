// Set Stamps: every real Speed Duel booster set has a stamp card with three stamps. Own a
// third of the set's cards and the first stamp pays a pack; own two thirds and the second
// lets you pick 1 of 3 cards from the set you're still missing; own the whole set and the
// third gives its top card the Overframe look plus 2 Duel Chips. Each stamp pays once per
// profile, ever, so nothing here can be farmed: the only way forward is collecting.
import { card } from '../eds/db';
import { rng } from '../eds/rng';
import { COPIES, owned, unplayableReason, withCards, withChips, type SpeedSave } from '../eds/speedSave';
import { OF_TIER, TIERS, cardLevels } from '../level/leveling';
import { withPacks } from './economy';
import { RARITIES, boosterSets, type Rarity, type SpeedSet } from './sets';

export const STAMPS = 3;
export const STAMP_CHIPS = 2;
export const PICK_FROM = 3;
export const STAMP_TEXT = ['a booster pack', 'pick 1 of 3 cards you’re missing', 'the top card at Overframe + 2 Duel Chips'];

type StampSave = SpeedSave & { stamps?: Record<string, number> };
const claimedOf = (s: SpeedSave, code: string) => (s as StampSave).stamps?.[code] ?? 0;

/** The set's cards a profile can collect: real cards, once each. */
export function setCardNames(set: SpeedSet): string[] {
  return [...new Set(set.cards.map(([n]) => n))].filter((n) => card(n) && card(n)!.sub !== 'Skill');
}

/** The rarest card the set prints (ties: the strongest monster, then by name). */
export function topCard(set: SpeedSet): string | null {
  const rank = (r: Rarity) => RARITIES.indexOf(r);
  const list = set.cards.filter(([n]) => card(n)).sort((a, b) => rank(b[1]) - rank(a[1]) || (card(b[0])?.atk ?? -1) - (card(a[0])?.atk ?? -1) || a[0].localeCompare(b[0]));
  return list[0]?.[0] ?? null;
}

export interface StampCard {
  set: SpeedSet;
  have: number;
  total: number;
  /** cards needed for each stamp */
  marks: number[];
  /** stamps reached by the collection, and stamps already paid */
  reached: number;
  claimed: number;
}

/** A stamp is reached at a third, two thirds and all of the set (rounded up). */
export function stampCard(s: SpeedSave, set: SpeedSet): StampCard {
  const names = setCardNames(set);
  const total = names.length;
  const have = names.filter((n) => owned(s, n) > 0).length;
  const marks = [Math.ceil(total / 3), Math.ceil((2 * total) / 3), total];
  const reached = total ? marks.filter((m) => have >= m).length : 0;
  return { set, have, total, marks, reached, claimed: claimedOf(s, set.code) };
}

export const stampCards = (s: SpeedSave): StampCard[] => boosterSets().map((set) => stampCard(s, set));
/** Stamps waiting to be claimed, over every set (for the menu note). */
export const stampsToClaim = (s: SpeedSave) => stampCards(s).reduce((a, c) => a + Math.max(0, c.reached - c.claimed), 0);

/** The 3 cards the second stamp offers: missing ones from the set (else ones you have fewest of). Same 3 until the collection changes. */
export function stampOffer(s: SpeedSave, set: SpeedSet): string[] {
  const names = setCardNames(set).filter((n) => !unplayableReason(n));
  let pool = names.filter((n) => owned(s, n) === 0);
  if (!pool.length) pool = names.filter((n) => owned(s, n) < COPIES);
  const seed = [...set.code].reduce((h, ch) => (Math.imul(h, 33) + ch.charCodeAt(0)) >>> 0, 0x57a3);
  const next = rng(seed + pool.length);
  const left = [...pool].sort();
  const out: string[] = [];
  while (out.length < PICK_FROM && left.length) out.push(left.splice(Math.floor(next() * left.length), 1)[0]);
  return out;
}

export interface Claimed {
  save: SpeedSave;
  line: string;
  cards: string[];
}

/**
 * Pays the next stamp on a set's card. The second stamp needs `pick`, one of stampOffer's
 * cards. Returns null when nothing can be claimed (or the pick isn't on offer).
 */
export function claimStamp(s: SpeedSave, code: string, pick?: string): Claimed | null {
  const set = boosterSets().find((x) => x.code === code);
  if (!set) return null;
  const c = stampCard(s, set);
  if (c.claimed >= c.reached || c.claimed >= STAMPS) return null;
  const stamps = { ...((s as StampSave).stamps ?? {}), [code]: c.claimed + 1 };
  let save = { ...s, stamps } as StampSave as SpeedSave;
  const short = set.name.replace(/^Speed Duel( GX)?:\s*/, '');
  if (c.claimed === 0) return { save: withPacks(save, 1), line: `${short} stamp 1: a booster pack`, cards: [] };
  if (c.claimed === 1) {
    const offer = stampOffer(s, set);
    if (!offer.length) return { save: withChips(save, 1), line: `${short} stamp 2: a Duel Chip`, cards: [] };
    if (!pick || !offer.includes(pick)) return null;
    return { save: withCards(save, [pick]), line: `${short} stamp 2: ${pick} is yours`, cards: [pick] };
  }
  const top = topCard(set);
  if (top) save = { ...save, levels: { ...cardLevels(save), [top]: Math.max(cardLevels(save)[top] ?? 0, TIERS[OF_TIER].at) } } as SpeedSave;
  save = withChips(save, STAMP_CHIPS);
  return { save, line: `${short} complete! ${top ? `${top} shines at Overframe, and ` : ''}${STAMP_CHIPS} Duel Chips`, cards: top ? [top] : [] };
}

// The real Speed Duel sets (public/cards/speedSets.json, written by the card-data job):
// which booster sets exist, in release order, which cards each one prints and at what
// rarity, and opening a pack from one. Without the set file (an old snapshot) every
// Speed Duel card goes in one "Speed Duel Mix" set so packs still work.
import { card, speedCards } from '../eds/db';
import { rng } from '../eds/rng';
import { unplayableReason } from '../eds/speedSave';

export type Rarity = 'Common' | 'Rare' | 'Super Rare' | 'Ultra Rare' | 'Secret Rare';
export const RARITIES: Rarity[] = ['Common', 'Rare', 'Super Rare', 'Ultra Rare', 'Secret Rare'];
export const RARITY_SHORT: Record<Rarity, string> = { Common: 'C', Rare: 'R', 'Super Rare': 'SR', 'Ultra Rare': 'UR', 'Secret Rare': 'ScR' };

export interface SpeedSet {
  name: string;
  code: string;
  date: string;
  cards: [string, Rarity][];
}

export const MIX_SET = 'Speed Duel Mix';
export const PACK_SIZE = 5;
/** The 5th card of a pack: Rare 55%, Super Rare 30%, Ultra Rare 10%, Secret Rare 5%. */
const TOP_SLOT: [Rarity, number][] = [
  ['Rare', 55],
  ['Super Rare', 30],
  ['Ultra Rare', 10],
  ['Secret Rare', 5],
];

let raw: SpeedSet[] | null = null;
let printed: SpeedSet[] | null = null;
let boosters: SpeedSet[] | null = null;
let baseRarity: Map<string, Rarity> | null = null;

const BASE = import.meta.env?.BASE_URL ?? '/';

/** Loads the set list (once). Fine to call again; resolves false when the file is missing. */
export async function loadSets(): Promise<boolean> {
  if (raw) return true;
  try {
    const res = await fetch(`${BASE}cards/speedSets.json`, { cache: 'no-cache' });
    if (!res.ok) return false;
    const list = (await res.json()) as SpeedSet[];
    if (!Array.isArray(list)) return false;
    setSets(list);
    return true;
  } catch {
    return false;
  }
}

/** Sets the set list directly (tests, or after loading). */
export function setSets(list: SpeedSet[] | null) {
  printed = list;
  raw = list ? withSpread(list) : null;
  boosters = null;
  baseRarity = null;
}

/**
 * The big Speed Duel boxes (Battle City, the GX boxes) list nearly every card as Common.
 * In a set with fewer than 5 cards above Common, each card shows the best rarity it was
 * ever printed at in any Speed Duel product, so packs from those boxes still have hits.
 */
function withSpread(list: SpeedSet[]): SpeedSet[] {
  const best = new Map<string, Rarity>();
  for (const st of list) for (const [n, r] of st.cards) if (!best.has(n) || rank(r) > rank(best.get(n)!)) best.set(n, r);
  return list.map((st) => {
    if (st.cards.filter(([, r]) => r !== 'Common').length >= 5) return st;
    return { ...st, cards: st.cards.map(([n, r]) => [n, best.get(n) && rank(best.get(n)!) > rank(r) ? best.get(n)! : r] as [string, Rarity]) };
  });
}

const rank = (r: string) => Math.max(0, RARITIES.indexOf(r as Rarity));

/** Products sold as packs: no ready-made decks or promos, and enough Commons to fill a pack (Tournament Packs 1-2 were all foils). */
const isBooster = (s: SpeedSet) => !/Starter Deck|Demo Deck|Duelist Kit|participation|promotional|Event Pack/i.test(s.name) && s.cards.filter(([, r]) => r === 'Common').length >= 10;

/** The booster sets, oldest first (a single mix set when the set file is missing). */
export function boosterSets(): SpeedSet[] {
  if (boosters) return boosters;
  const real = (raw ?? []).filter((s) => s.cards.some(([n]) => card(n))).filter(isBooster);
  boosters = real.length ? real : [mixSet()];
  return boosters;
}

function mixSet(): SpeedSet {
  const cards: [string, Rarity][] = speedCards().map((c) => [c.name, guessRarity(c.name)]);
  return { name: MIX_SET, code: 'MIX', date: '', cards };
}

/** Without set data: strong or Fusion monsters are Super Rare, Level 5+ are Rare, the rest Common. */
function guessRarity(name: string): Rarity {
  const c = card(name);
  if (!c) return 'Common';
  if (c.sub === 'Fusion' || (c.atk ?? 0) >= 2500) return 'Super Rare';
  if ((c.level ?? 0) >= 5) return 'Rare';
  return 'Common';
}

/**
 * A card's rarity for crafting, breaking and the binder: the rarity it comes at in packs
 * (its best one across the booster sets), else its lowest printing anywhere (a card only
 * in Starter Decks is Common). Skills count as Ultra Rare.
 */
export function rarityOf(name: string): Rarity {
  if (!baseRarity) {
    baseRarity = new Map();
    const inPacks = new Map<string, Rarity>();
    for (const s of boosterSets()) for (const [n, r] of s.cards) if (!inPacks.has(n) || rank(r) > rank(inPacks.get(n)!)) inPacks.set(n, r);
    for (const s of printed ?? []) for (const [n, r] of s.cards) if (!baseRarity.has(n) || rank(r) < rank(baseRarity.get(n)!)) baseRarity.set(n, r);
    for (const [n, r] of inPacks) baseRarity.set(n, r);
  }
  if (card(name)?.sub === 'Skill') return 'Ultra Rare';
  return baseRarity.get(name) ?? guessRarity(name);
}

/** The booster sets this profile can buy packs of: one more for every WINS_PER_SET wins. */
export const WINS_PER_SET = 4;
export function unlockedSets(wins: number): SpeedSet[] {
  const all = boosterSets();
  return all.slice(0, Math.min(all.length, 1 + Math.floor(wins / WINS_PER_SET)));
}

export function setByName(name: string | undefined): SpeedSet | undefined {
  return boosterSets().find((s) => s.name === name);
}

/** A short name for a set: "Speed Duel: Attack from the Deep" -> "Attack from the Deep". */
export const shortSetName = (name: string) => name.replace(/^Speed Duel( GX)?:\s*/, '');

/**
 * Opens one pack: 4 Commons and a Rare-or-better. Prefers cards the game can play.
 * Matches the campaign's PackOpener signature: an unknown or missing set picks one of the
 * booster sets at random, and `pool` is only used when there are no sets at all.
 */
export function openPack(setName: string | undefined, pool: string[] = [], seed = Date.now()): string[] {
  const next = rng(seed);
  const sets = boosterSets();
  const set = setByName(setName) ?? sets[Math.floor(next() * sets.length)];
  if (!set || !set.cards.length) return pool.slice(0, PACK_SIZE);
  const byRarity = (r: Rarity) => {
    const all = set.cards.filter(([, x]) => x === r).map(([n]) => n);
    const good = all.filter((n) => card(n) && !unplayableReason(n));
    return good.length ? good : all.filter((n) => card(n));
  };
  const pick = (list: string[]) => list[Math.floor(next() * list.length)];
  const out: string[] = [];
  const commons = byRarity('Common');
  const fallback = set.cards.map(([n]) => n).filter((n) => card(n));
  // No card twice among a pack's Commons (when the set has enough of them).
  const left = [...(commons.length ? commons : fallback)];
  for (let i = 0; i < PACK_SIZE - 1; i++) {
    const n = pick(left);
    out.push(n);
    if (left.length > PACK_SIZE) left.splice(left.indexOf(n), 1);
  }
  // The top slot rolls a rarity.
  let roll = next() * 100;
  let want: Rarity = 'Rare';
  for (const [r, w] of TOP_SLOT) {
    if (roll < w) {
      want = r;
      break;
    }
    roll -= w;
  }
  // Speed Duel boxes often skip Rare (Commons, Super and Secret Rares only): step down to
  // Rare, then up, so the top card is always Rare or better when the set has one.
  const order = [...RARITIES.slice(1, rank(want) + 1).reverse(), ...RARITIES.slice(rank(want) + 1), 'Common' as Rarity];
  for (const r of order) {
    const list = byRarity(r);
    if (list.length) {
      out.push(pick(list));
      break;
    }
  }
  while (out.length < PACK_SIZE) out.push(pick(fallback));
  // The hit lands in a random spot, so every flip could be it.
  const hit = out.pop()!;
  out.splice(Math.floor(next() * PACK_SIZE), 0, hit);
  return out;
}

/** The rarity a card shows in a given set (for the pack reveal). */
export function rarityIn(setName: string | undefined, name: string): Rarity {
  const s = setByName(setName);
  return (s?.cards.find(([n]) => n === name)?.[1] as Rarity) ?? rarityOf(name);
}

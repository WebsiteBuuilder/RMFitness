// The Speed Duel collection economy: what each profile owns, how packs, Duel Chips and
// shards come in, and what they can be spent on. Everything is kept in the profile's
// Speed Duel save (eds.speed.<id>) next to its decks.
//
// - Decks (except "Anything goes" decks) can only use copies the profile owns.
// - Packs are prizes: 3 welcome packs, the first win against each computer duelist each
//   day, up to 3 wins a day against another player, and whatever the campaign hands out.
// - Duel Chips are rare on purpose: at most 1 a day from beating another player, plus the
//   campaign's own (first 3-star win, Labyrinth bosses). 10 shards also make a chip, and
//   shards only come from breaking spare copies. A profile holds at most CHIP_CAP.
// - Chips craft a card (1 to 8 by rarity) or lift a card's look one rarity step (3).
import { card } from '../eds/db';
import { CHIP_CAP, COPIES, isExtraCard, owned, withCards, withChips, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { TIERS, cardLevels, tierIndex } from '../level/leveling';
import { openPack, rarityIn, rarityOf, unlockedSets, type Rarity } from './sets';

export const SHARDS_PER_CHIP = 10;
/** an Ultra Rare or better is guaranteed at least once every PITY packs */
export const PITY = 10;
export const WELCOME_PACKS = 3;
export const RIVAL_PACKS_PER_DAY = 3;
/** a win against another player only pays prizes when the duel lasted this many turns */
export const RIVAL_MIN_TURNS = 3;
export const LOOK_UP_COST = 3;
export const CRAFT_COST: Record<Rarity, number> = { Common: 1, Rare: 2, 'Super Rare': 4, 'Ultra Rare': 6, 'Secret Rare': 8 };
export const BREAK_SHARDS: Record<Rarity, number> = { Common: 1, Rare: 2, 'Super Rare': 3, 'Ultra Rare': 5, 'Secret Rare': 8 };

export interface Rival {
  w: number;
  l: number;
  d: number;
  /** current run: positive = wins in a row, negative = losses in a row */
  streak: number;
}

interface Daily {
  day: string;
  /** computer duelists beaten today (each pays one pack, once a day) */
  cpu: string[];
  /** packs won from other players today */
  rivalPacks: number;
  /** the day's chip from beating another player was paid */
  rivalChip: boolean;
}

export type EconSave = SpeedSave & {
  /** set once the profile has been moved to the collection economy */
  econ?: 1;
  shards?: number;
  /** unopened packs */
  packs?: number;
  daily?: Daily;
  /** head-to-head records against other players (Link Battles) */
  rivals?: Record<string, Rival>;
  levels?: Record<string, number>;
  /** packs opened since the last Ultra Rare or better */
  dry?: number;
};

const E = (s: SpeedSave) => s as EconSave;
export const chipsOf = (s: SpeedSave) => s.chips ?? 0;
export const shardsOf = (s: SpeedSave) => E(s).shards ?? 0;
export const packsOf = (s: SpeedSave) => E(s).packs ?? 0;
export const rivalsOf = (s: SpeedSave): Record<string, Rival> => E(s).rivals ?? {};

export const dayKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function daily(s: SpeedSave, now: number): Daily {
  const d = E(s).daily;
  // Setting the phone's clock back doesn't start a fresh day.
  // (A saved day far in the future means the clock was wrong then, so it starts over.)
  const today = dayKey(now);
  const keep = d && (d.day === today || (d.day > today && d.day <= dayKey(now + 86_400_000)));
  return keep ? d! : { day: today, cpu: [], rivalPacks: 0, rivalChip: false };
}

const countsOf = (list: string[]) => {
  const m: Record<string, number> = {};
  for (const n of list) m[n] = (m[n] ?? 0) + 1;
  return m;
};
const deckCards = (d: SpeedDeck) => [...d.main, ...d.extra, ...(d.skill ? [d.skill] : [])];

/**
 * Moves a profile onto the collection economy, once. Profiles from before it own every
 * copy their decks already use (so no deck breaks) and everyone gets the welcome packs.
 */
export function migrate(s: SpeedSave): SpeedSave {
  if (E(s).econ) return s;
  const collection = { ...(s.collection ?? {}) };
  for (const d of s.decks) {
    if (d.open) continue;
    for (const [n, c] of Object.entries(countsOf(deckCards(d)))) collection[n] = Math.max(collection[n] ?? 0, Math.min(c, COPIES));
  }
  return { ...s, collection, econ: 1, packs: packsOf(s) + (claimWelcome() ? WELCOME_PACKS : 0) } as EconSave;
}

/** Welcome packs go to the first 2 profiles on a phone, so new profiles aren't a pack farm. */
const WELCOME_KEY = 'eds.speed.welcomed';
export const WELCOME_PROFILES = 2;
function claimWelcome(): boolean {
  try {
    const n = Number(localStorage.getItem(WELCOME_KEY) ?? 0);
    if (n >= WELCOME_PROFILES) return false;
    localStorage.setItem(WELCOME_KEY, String(n + 1));
  } catch {
    /* storage blocked (tests): no limit */
  }
  return true;
}

/** The first deck of a new profile: its cards (and Skill) become theirs. */
export function withStarter(s: SpeedSave, d: SpeedDeck): SpeedSave {
  return withCards(s, deckCards(d));
}

/** The most copies of a card any of the profile's collection decks uses. */
export function copiesInDecks(s: SpeedSave, name: string): number {
  let most = 0;
  for (const d of s.decks) if (!d.open) most = Math.max(most, deckCards(d).filter((n) => n === name).length);
  return most;
}

/** Copies the profile could give up (bet, break) without breaking one of its decks. */
export const spareCopies = (s: SpeedSave, name: string) => Math.max(0, owned(s, name) - copiesInDecks(s, name));

/** What a deck uses that the profile doesn't own, in the player's words. */
export function collectionProblems(s: SpeedSave, d: SpeedDeck): string[] {
  if (d.open) return [];
  const out: string[] = [];
  for (const [n, c] of Object.entries(countsOf(deckCards(d)))) {
    const have = owned(s, n);
    if (have < c) out.push(have === 0 ? `You don't own ${n}` : `You own ${have} ${n}, the deck uses ${c}`);
  }
  return out;
}

/** A deck made from a ready-made list, keeping only the copies the profile owns. */
export function ownedOnly(s: SpeedSave, d: SpeedDeck): SpeedDeck {
  const left: Record<string, number> = { ...(s.collection ?? {}) };
  const keep = (n: string) => ((left[n] ?? 0) > 0 ? (left[n]--, true) : false);
  return { ...d, main: d.main.filter(keep), extra: d.extra.filter(keep), skill: d.skill && owned(s, d.skill) > 0 ? d.skill : null };
}

/** Turns shards into chips while there is room. */
function cashShards(s: SpeedSave): SpeedSave {
  let shards = shardsOf(s);
  let chips = chipsOf(s);
  while (shards >= SHARDS_PER_CHIP && chips < CHIP_CAP) {
    shards -= SHARDS_PER_CHIP;
    chips++;
  }
  return { ...s, shards, chips } as EconSave;
}

/** Copies past the 3 a deck can use are broken into shards automatically. */
export function breakExtras(s: SpeedSave): { save: SpeedSave; shards: number } {
  const collection = { ...(s.collection ?? {}) };
  let gained = 0;
  for (const [n, c] of Object.entries(collection)) {
    if (c > COPIES) {
      gained += (c - COPIES) * BREAK_SHARDS[rarityOf(n)];
      collection[n] = COPIES;
    }
  }
  if (!gained) return { save: s, shards: 0 };
  return { save: cashShards({ ...s, collection, shards: shardsOf(s) + gained } as EconSave), shards: gained };
}

/** Breaks every spare copy: what no deck uses, keeping one of each card. Returns null when there's nothing to break. */
export function breakAllSpares(s: SpeedSave): { save: SpeedSave; copies: number; shards: number } | null {
  let next = s;
  let copies = 0;
  for (const n of Object.keys(s.collection ?? {})) {
    while (owned(next, n) > 1 && spareCopies(next, n) > 0) {
      next = breakCopy(next, n)!;
      copies++;
    }
  }
  if (!copies) return null;
  return { save: next, copies, shards: shardsOf(next) - shardsOf(s) + (chipsOf(next) - chipsOf(s)) * SHARDS_PER_CHIP };
}

/** What a profile can still win today: computer duelists not yet beaten, rival packs, the rival chip. */
export function todaysPrizes(s: SpeedSave, cpus: string[], now = Date.now()): { cpu: string[]; rivalPacks: number; rivalChip: boolean } {
  const d = daily(s, now);
  return { cpu: cpus.filter((c) => !d.cpu.includes(c)), rivalPacks: RIVAL_PACKS_PER_DAY - d.rivalPacks, rivalChip: !d.rivalChip };
}

/** Breaks one spare copy into shards. */
export function breakCopy(s: SpeedSave, name: string): SpeedSave | null {
  // Never the last copy: breaking keeps at least one of every card.
  if (spareCopies(s, name) < 1 || owned(s, name) < 2) return null;
  const collection = { ...(s.collection ?? {}) };
  collection[name]--;
  if (!collection[name]) delete collection[name];
  return cashShards({ ...s, collection, shards: shardsOf(s) + BREAK_SHARDS[rarityOf(name)] } as EconSave);
}

export const craftCost = (name: string) => CRAFT_COST[rarityOf(name)];

/** Why a card can't be crafted right now, or null. */
export function cantCraft(s: SpeedSave, name: string): string | null {
  const c = card(name);
  if (!c || !c.speed) return 'not a Speed Duel card';
  if (owned(s, name) >= (c.sub === 'Skill' ? 1 : COPIES)) return c.sub === 'Skill' ? 'you own this Skill' : `you own the most (${COPIES})`;
  if (chipsOf(s) < craftCost(name)) return `needs ${craftCost(name)} Duel Chip${craftCost(name) === 1 ? '' : 's'}`;
  return null;
}

export function craft(s: SpeedSave, name: string): SpeedSave | null {
  if (cantCraft(s, name)) return null;
  return withChips(withCards(s, [name]), -craftCost(name));
}

/** Why a card's look can't be lifted one rarity step, or null. */
export function cantLookUp(s: SpeedSave, name: string): string | null {
  if (owned(s, name) < 1) return "you don't own it";
  if (tierIndex(cardLevels(s)[name] ?? 0) >= TIERS.length - 1) return 'already Overframe';
  if (chipsOf(s) < LOOK_UP_COST) return `needs ${LOOK_UP_COST} Duel Chips`;
  return null;
}

/** Lifts a card's rarity look to the start of the next rarity (the look only, never its stats). */
export function lookUp(s: SpeedSave, name: string): SpeedSave | null {
  if (cantLookUp(s, name)) return null;
  const levels = { ...cardLevels(s) };
  levels[name] = TIERS[tierIndex(levels[name] ?? 0) + 1].at;
  return withChips({ ...s, levels } as EconSave, -LOOK_UP_COST);
}

export interface Opened {
  save: SpeedSave;
  set: string | undefined;
  cards: string[];
  /** cards this profile didn't have before */
  fresh: string[];
  /** shards from copies past 3 */
  shards: number;
}

/** Opens one of the profile's unopened packs from a set it has unlocked. */
/** Packs left until an Ultra Rare or better is guaranteed. */
export const pityLeft = (s: SpeedSave) => PITY - (E(s).dry ?? 0);

export function openOwnedPack(s: SpeedSave, setName: string, seed = Date.now()): Opened | null {
  if (packsOf(s) < 1 || !unlockedSets(s.wins).some((x) => x.name === setName)) return null;
  const cards = openPack(setName, [], seed, pityLeft(s) <= 1 ? 'Ultra Rare' : 'Rare');
  const big = cards.some((n) => ['Ultra Rare', 'Secret Rare'].includes(rarityIn(setName, n)));
  const fresh = [...new Set(cards.filter((n) => owned(s, n) === 0))];
  const { save, shards } = breakExtras(withCards({ ...s, packs: packsOf(s) - 1, dry: big ? 0 : (E(s).dry ?? 0) + 1 } as EconSave, cards));
  return { save, set: setName, cards, fresh, shards };
}

export const withPacks = (s: SpeedSave, n: number): SpeedSave => ({ ...s, packs: packsOf(s) + n }) as EconSave;

/** Duel the Computer: the first win against each duelist each day pays a pack. */
export function cpuWinPrize(s: SpeedSave, opp: string, deck: SpeedDeck | null, now = Date.now()): { save: SpeedSave; lines: string[] } {
  if (deck?.open) return { save: s, lines: [] };
  const d = daily(s, now);
  if (d.cpu.includes(opp)) return { save: s, lines: [] };
  return { save: { ...withPacks(s, 1), daily: { ...d, cpu: [...d.cpu, opp] } } as EconSave, lines: [`A booster pack for beating ${opp} today`] };
}

export interface RivalDuel {
  result: 'w' | 'l' | 'd';
  opp: string;
  turns: number;
  /** both players are profiles with collection decks, so the duel pays prizes */
  counts: boolean;
}

/** A Link Battle against another player: the head-to-head record and the day's prizes. */
export function rivalResult(s: SpeedSave, r: RivalDuel, now = Date.now()): { save: SpeedSave; lines: string[] } {
  const rivals = { ...rivalsOf(s) };
  const old = rivals[r.opp] ?? { w: 0, l: 0, d: 0, streak: 0 };
  const rec = { ...old, [r.result]: old[r.result] + 1 };
  rec.streak = r.result === 'w' ? Math.max(0, old.streak) + 1 : r.result === 'l' ? Math.min(0, old.streak) - 1 : 0;
  rivals[r.opp] = rec;
  let next = { ...s, rivals } as EconSave as SpeedSave;
  const lines: string[] = [];
  // A quick surrender doesn't pay: prizes need a real duel of a few turns.
  if (r.result === 'w' && r.counts && r.turns >= RIVAL_MIN_TURNS) {
    const d = { ...daily(s, now) };
    if (d.rivalPacks < RIVAL_PACKS_PER_DAY) {
      d.rivalPacks++;
      next = withPacks(next, 1);
      lines.push(`A booster pack for beating ${r.opp}`);
    }
    if (!d.rivalChip && chipsOf(next) < CHIP_CAP) {
      d.rivalChip = true;
      next = withChips(next, 1);
      lines.push("A Duel Chip: today's win over a rival");
    }
    next = { ...next, daily: d } as EconSave;
  }
  return { save: next, lines };
}

/** Who wears the King of Games crown between this profile and a rival: 'me', 'them' or null (tied). */
export function crownHolder(s: SpeedSave, rival: string): 'me' | 'them' | null {
  const r = rivalsOf(s)[rival];
  if (!r || r.w === r.l) return null;
  return r.w > r.l ? 'me' : 'them';
}

/** The rival this profile leads by the most, for the menu's crown. */
export function bestCrown(s: SpeedSave): { rival: string; rec: Rival } | null {
  let best: { rival: string; rec: Rival } | null = null;
  for (const [rival, rec] of Object.entries(rivalsOf(s))) if (rec.w > rec.l && (!best || rec.w - rec.l > best.rec.w - best.rec.l)) best = { rival, rec };
  return best;
}

/** Cards sorted for the collection screen: monsters, spells, traps, then Extra Deck and Skills. */
export function sortForBinder(names: string[]): string[] {
  const kind = (n: string) => {
    const c = card(n);
    if (!c) return 9;
    if (c.sub === 'Skill') return 5;
    if (isExtraCard(n)) return 4;
    return c.kind === 'monster' ? 1 : c.kind === 'spell' ? 2 : 3;
  };
  return [...names].sort((a, b) => kind(a) - kind(b) || a.localeCompare(b));
}

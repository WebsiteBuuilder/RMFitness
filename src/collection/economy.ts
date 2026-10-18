// The Speed Duel collection economy: what each profile owns, how packs, Duel Chips and
// shards come in, and what they can be spent on. Everything is kept in the profile's
// Speed Duel save (eds.speed.<id>) next to its decks.
//
// - Decks (except "Anything goes" decks) can only use copies the profile owns.
// - Packs are prizes: 3 welcome packs, the first win against each computer duelist each
//   day, every online win against another player, up to 3 one-phone wins a day against
//   another player, and whatever the campaign hands out. Every card in a pack rolls the
//   rarity it comes out at (see finish.ts).
// - Duel Chips are rare on purpose: at most 1 a day from beating another player, plus the
//   campaign's own (first 3-star win, Labyrinth bosses). 10 shards also make a chip, and
//   shards only come from breaking spare copies. A profile holds at most CHIP_CAP.
// - Chips craft a card (1 to 8 by rarity) or lift a card's look one rarity step (3).
import { card } from '../eds/db';
import { CHIP_CAP, COPIES, isExtraCard, owned, withCards, withChips, type SpeedDeck, type SpeedSave } from '../eds/speedSave';
import { OF_TIER, TIERS, cardLevels, tierIndex } from '../level/leveling';
import { rollFinishes, withFinishes } from './finish';
import { RETIRED, RETIRED_PRICE, dropRetired } from './retired';
import { openPack, rarityIn, rarityOf, setByName, unlockedSets, type Rarity } from './sets';

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
  /** the phone's clock reads earlier than a day already played: nothing pays until it passes */
  spent?: boolean;
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
  /** unopened gift packs: they open from any booster set, locked ones too */
  giftPacks?: number;
  /** the one-time gifts this profile already got (see GIFT) */
  gifts?: string[];
  /** retired cards paid back so far (copies) and the Duel Chips they were worth, for the one-time notice */
  retiredRefund?: number;
  retiredChips?: number;
};

const E = (s: SpeedSave) => s as EconSave;
export const chipsOf = (s: SpeedSave) => s.chips ?? 0;
export const shardsOf = (s: SpeedSave) => E(s).shards ?? 0;
/** every unopened pack the profile has, gift packs included */
export const packsOf = (s: SpeedSave) => ownPacks(s) + giftPacksOf(s);
const ownPacks = (s: SpeedSave) => E(s).packs ?? 0;
export const giftPacksOf = (s: SpeedSave) => E(s).giftPacks ?? 0;
export const rivalsOf = (s: SpeedSave): Record<string, Rival> => E(s).rivals ?? {};

export const dayKey = (now = Date.now()) => {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function daily(s: SpeedSave, now: number): Daily {
  const d = E(s).daily;
  // Only a day later than every day already played is a fresh day. Setting the clock
  // back (or forward and back again) pays nothing until the real date passes the saved one.
  const today = dayKey(now);
  if (d && d.day === today) return d;
  if (d && d.day > today) return { ...d, spent: true };
  return { day: today, cpu: [], rivalPacks: 0, rivalChip: false };
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
  if (E(s).econ) return retireCards(s);
  const collection = { ...(s.collection ?? {}) };
  for (const d of s.decks) {
    if (d.open) continue;
    for (const [n, c] of Object.entries(countsOf(deckCards(d)))) collection[n] = Math.max(collection[n] ?? 0, Math.min(c, COPIES));
  }
  return retireCards({ ...s, collection, econ: 1, packs: ownPacks(s) + (claimWelcome() ? WELCOME_PACKS : 0) } as EconSave);
}

/** Copies of retired cards paid back between two versions of a save (0 when none). */
export const retiredPaid = (before: SpeedSave, after: SpeedSave) => ({
  copies: (E(after).retiredRefund ?? 0) - (E(before).retiredRefund ?? 0),
  chips: (E(after).retiredChips ?? 0) - (E(before).retiredChips ?? 0),
  decks: after.decks.filter((d, i) => d !== before.decks[i]).map((d) => d.name),
});

/** The one-time notice for a save that just lost its retired cards. */
export function retiredNotice(p: { copies: number; chips: number; decks: string[] }): string {
  const parts = ['Some cards were never printed for Speed Duel, so they are gone from the game.'];
  if (p.chips) parts.push(`You owned ${p.copies} cop${p.copies === 1 ? 'y' : 'ies'} of them: you got ${p.chips} Duel Chip${p.chips === 1 ? '' : 's'} worth back.`);
  if (p.decks.length) parts.push(`They left ${p.decks.length === 1 ? 'your deck' : 'your decks'} ${p.decks.map((n) => `"${n}"`).join(', ')}: check ${p.decks.length === 1 ? 'it' : 'them'} in Deck Edit.`);
  return parts.join(' ');
}

/**
 * Takes the cards that were never Speed Duel cards (RETIRED) out of a profile: every owned
 * copy pays back what it cost to craft, every rarity step its look was lifted pays back
 * LOOK_UP_COST, they leave its decks, and their looks go. The payback comes as shards, so
 * past the chip cap nothing is lost. Returns the same save when there is nothing to do.
 */
export function retireCards(s: SpeedSave): SpeedSave {
  const owned = Object.entries(s.collection ?? {}).filter(([n]) => RETIRED.has(n));
  const decks = s.decks.map(dropRetired);
  const levels = E(s).levels;
  const looks = levels ? Object.keys(levels).filter((n) => RETIRED.has(n)) : [];
  if (!owned.length && !looks.length && decks.every((d, i) => d === s.decks[i])) return s;
  const collection = { ...(s.collection ?? {}) };
  let copies = 0;
  let chips = 0;
  for (const [n, c] of owned) {
    copies += c;
    chips += c * (RETIRED_PRICE.get(n) ?? 1);
    delete collection[n];
  }
  const next = { ...s, collection, decks } as EconSave;
  if (levels && looks.length) {
    next.levels = { ...levels };
    for (const n of looks) {
      chips += tierIndex(levels[n]) * LOOK_UP_COST;
      delete next.levels[n];
    }
  }
  next.retiredRefund = (E(s).retiredRefund ?? 0) + copies;
  next.retiredChips = (E(s).retiredChips ?? 0) + chips;
  return cashShards({ ...next, shards: shardsOf(next) + chips * SHARDS_PER_CHIP } as EconSave);
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

/** The most copies of a card any of the profile's collection decks uses (the Millennium Road deck included). */
export function copiesInDecks(s: SpeedSave, name: string): number {
  let most = 0;
  for (const d of [...s.decks, ...(s.road ? [s.road] : [])]) if (!d.open) most = Math.max(most, deckCards(d).filter((n) => n === name).length);
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
  if (d.spent) return { cpu: [], rivalPacks: 0, rivalChip: false };
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
  if (tierIndex(cardLevels(s)[name] ?? 0) >= OF_TIER) return 'already Overframe';
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
  /** the rarity each card came out at (a TIERS index, see finish.ts) */
  finishes: number[];
}

/** Packs left until an Ultra Rare or better is guaranteed. */
export const pityLeft = (s: SpeedSave) => PITY - (E(s).dry ?? 0);

/** How many of the profile's packs can open as this set: gift packs open any set, the rest only unlocked ones. */
export function packsFor(s: SpeedSave, setName: string): number {
  return giftPacksOf(s) + (unlockedSets(s.wins).some((x) => x.name === setName) ? ownPacks(s) : 0);
}

/** Opens one of the profile's unopened packs (a gift pack first) from a set it can open. */
export function openOwnedPack(s: SpeedSave, setName: string, seed = Date.now()): Opened | null {
  if (packsFor(s, setName) < 1 || !setByName(setName)) return null;
  const gift = giftPacksOf(s) > 0;
  const cards = openPack(setName, [], seed, pityLeft(s) <= 1 ? 'Ultra Rare' : 'Rare');
  const big = cards.some((n) => ['Ultra Rare', 'Secret Rare'].includes(rarityIn(setName, n)));
  const fresh = [...new Set(cards.filter((n) => owned(s, n) === 0))];
  const finishes = rollFinishes(setName, cards, seed);
  const { save, shards } = breakExtras(withCards({ ...s, ...(gift ? { giftPacks: giftPacksOf(s) - 1 } : { packs: ownPacks(s) - 1 }), dry: big ? 0 : (E(s).dry ?? 0) + 1 } as EconSave, cards));
  return { save: withFinishes(save, cards, finishes), set: setName, cards, fresh, shards, finishes };
}

export const withPacks = (s: SpeedSave, n: number): SpeedSave => ({ ...s, packs: ownPacks(s) + n }) as EconSave;

/**
 * One-time presents from the game's owner. Each profile gets each gift once (the save
 * remembers it, and the save backs up with the shared account, so logging in on another
 * phone can't claim it again), and only profiles made before its `madeBefore`, so a new
 * spare profile isn't a pack farm. A new gift is a new entry in GIFTS with a new id.
 */
export interface Gift {
  id: string;
  /** change this to give a different number of packs */
  packs: number;
  title: string;
  /** the big line over the wrapped box (default "A present for you") */
  heading?: string;
  /** the line under the heading */
  note: string;
  /** the line under the pack count once opened */
  opened?: string;
  madeBefore: number;
}
export const GIFT: Gift = {
  id: 'matchmaking-live',
  packs: 250,
  title: 'Find a Match is live!',
  note: 'To celebrate online matchmaking, every duelist gets a surprise.',
  madeBefore: Date.UTC(2026, 9, 18),
};
export const BONUS_GIFT: Gift = {
  id: 'bonus-drop-1',
  packs: 145,
  title: 'Bonus drop!',
  heading: 'A bonus present',
  opened: 'Any set, any rarity, Overframe included. Hit Random deck after for fresh builds.',
  note: 'More cards for your decks: a bonus present for every duelist.',
  madeBefore: Date.UTC(2026, 9, 21),
};
/** every gift, oldest first: a profile opens the ones it hasn't had, one after another */
export const GIFTS: Gift[] = [GIFT, BONUS_GIFT];
/** A phone hands each gift to at most this many profiles (like the welcome packs). */
export const GIFT_PROFILES = 2;

/** The profiles this phone already gave a gift to (only these can claim it here once the phone's share is used). */
const giftedKey = (id: string) => `eds.speed.gifted.${id}`;
function giftedHere(gift: Gift): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(giftedKey(gift.id)) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return []; // storage blocked (tests): no limit
  }
}

/** The gift this profile can still claim (null: already claimed, made too late, or this phone gave out its share). */
export function giftFor(s: SpeedSave, created: number, gift: Gift = GIFT, profileId?: string): Gift | null {
  if ((E(s).gifts ?? []).includes(gift.id) || created >= gift.madeBefore) return null;
  if (profileId) {
    const here = giftedHere(gift);
    // A profile on the list may claim again only if its save lost the gift (an account sync kept another phone's copy).
    if (!here.includes(profileId) && here.length >= GIFT_PROFILES) return null;
  }
  return gift;
}

/** Claims the gift: its packs go in as gift packs, and the profile can never claim it again. */
export function claimGift(s: SpeedSave, created: number, gift: Gift = GIFT, profileId?: string): SpeedSave | null {
  if (!giftFor(s, created, gift, profileId)) return null;
  if (profileId)
    try {
      localStorage.setItem(giftedKey(gift.id), JSON.stringify([...new Set([...giftedHere(gift), profileId])]));
    } catch {
      /* storage blocked */
    }
  return { ...s, giftPacks: giftPacksOf(s) + gift.packs, gifts: [...(E(s).gifts ?? []), gift.id] } as EconSave;
}

/** The oldest gift this profile can still claim, skipping any in `skip` (put off with "Not now"). */
export function nextGift(s: SpeedSave, created: number, profileId?: string, skip: string[] = []): Gift | null {
  for (const g of GIFTS) if (!skip.includes(g.id) && giftFor(s, created, g, profileId)) return g;
  return null;
}

/** Duel the Computer: the first win against each duelist each day pays a pack. */
export function cpuWinPrize(s: SpeedSave, opp: string, deck: SpeedDeck | null, now = Date.now()): { save: SpeedSave; lines: string[] } {
  if (deck?.open) return { save: s, lines: [] };
  const d = daily(s, now);
  if (d.spent || d.cpu.includes(opp)) return { save: s, lines: [] };
  return { save: { ...withPacks(s, 1), daily: { ...d, cpu: [...d.cpu, opp] } } as EconSave, lines: [`A booster pack for beating ${opp} today`] };
}

export interface RivalDuel {
  result: 'w' | 'l' | 'd';
  opp: string;
  turns: number;
  /** both players are profiles with collection decks, so the duel pays prizes */
  counts: boolean;
  /** played over the internet (each on their own phone): every win pays a pack, no daily cap */
  online?: boolean;
  /** the duel ended by one player giving up */
  surrender?: boolean;
  /** Life Points either player lost during the duel */
  damage?: number;
}

/**
 * A duel that's too short to say anything: given up before each player has had a full turn
 * and before any damage. It counts for neither the King of Games record nor rival prizes.
 */
export const tooQuick = (r: Pick<RivalDuel, 'surrender' | 'turns' | 'damage'>) => !!r.surrender && r.turns < RIVAL_MIN_TURNS && !(r.damage ?? 0);

/** A Link Battle against another player: the head-to-head record and the day's prizes. */
export function rivalResult(s: SpeedSave, r: RivalDuel, now = Date.now()): { save: SpeedSave; lines: string[] } {
  if (tooQuick(r)) return { save: s, lines: r.result === 'w' ? [`${r.opp} gave up before the duel got going: it doesn't count for your record with them`] : [] };
  const rivals = { ...rivalsOf(s) };
  const old = rivals[r.opp] ?? { w: 0, l: 0, d: 0, streak: 0 };
  const rec = { ...old, [r.result]: old[r.result] + 1 };
  rec.streak = r.result === 'w' ? Math.max(0, old.streak) + 1 : r.result === 'l' ? Math.min(0, old.streak) - 1 : 0;
  rivals[r.opp] = rec;
  let next = { ...s, rivals } as EconSave as SpeedSave;
  const lines: string[] = [];
  // A quick surrender doesn't pay: prizes need a real duel of a few turns.
  const d = { ...daily(s, now) };
  if (r.result === 'w' && r.counts && r.turns >= RIVAL_MIN_TURNS && !d.spent) {
    if (r.online) {
      next = withPacks(next, 1);
      lines.push(`A booster pack for beating ${r.opp} online`);
    } else if (d.rivalPacks < RIVAL_PACKS_PER_DAY) {
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

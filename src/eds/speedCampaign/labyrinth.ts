// Duel Labyrinth: the roguelite. A run is three floors of branching stops, generated from a
// seed so the Daily Labyrinth is the same for everyone who plays it that day. Every change
// returns a new Run, and the run is saved after each stop.
import { card } from '../db';
import { rng } from '../rng';
import { COPIES, MAIN_MAX, STARTERS, deckFromStarter } from '../speedSave';
import type { SeatSetup } from '../types';
import { CHAPTERS } from './roster';
import { deckOf, expand } from './campaign';
import { COMMON_RELICS, MILLENNIUM, mergeSetups, relic } from './relics';
import type { CpuDuelist, DuelCondition } from './types';

export type StopKind = 'duel' | 'elite' | 'shop' | 'event' | 'rest' | 'treasure' | 'boss';

export interface Stop {
  id: string;
  kind: StopKind;
  row: number;
  col: number;
  /** ids of stops on the next row this one leads to */
  next: string[];
  /** duels: who */
  foe?: string;
  /** events: which */
  event?: string;
}

export interface Floor {
  rows: Stop[][];
}

export interface ShopItem {
  kind: 'card' | 'remove' | 'heal' | 'relic';
  name?: string;
  price: number;
  sold?: boolean;
}

export interface Run {
  id: string;
  seed: number;
  /** YYYY-MM-DD for a Daily Labyrinth */
  daily?: string;
  /** the Starter Deck's character, or the name of your own deck the run began with */
  starter: string;
  /** the run began with one of your own decks instead of a Starter Deck */
  ownDeck?: boolean;
  /** that deck was an Anything goes deck: the run counts, but pays no chips or Soul Fragments */
  open?: boolean;
  main: string[];
  extra: string[];
  skill: string | null;
  hearts: number;
  maxHearts: number;
  dp: number;
  relics: string[];
  curse: number;
  floors: Floor[];
  floor: number;
  /** the stop you are on (null before the first) */
  at: string | null;
  visited: string[];
  wins: number;
  /** the next duel's own handicap or boon from an event */
  nextDuel?: { me?: SeatSetup; cpu?: SeatSetup; text: string; prize?: 'relic' };
  /** a choice waiting on the player (cards after a win, a shop, an event) */
  pending?: Pending;
  /** a duel stop you are on whose duel hasn't been played yet */
  inDuel?: string;
  /** set while that duel is actually being played: if the app closes mid-duel, it counts as lost */
  staked?: boolean;
  over?: 'won' | 'lost';
  step: number;
}

export type Pending =
  | { kind: 'draft'; options: string[]; dp: number; heal?: boolean; relic?: string; chip?: boolean }
  | { kind: 'shop'; items: ShopItem[] }
  | { kind: 'event'; event: string }
  | { kind: 'rest' }
  | { kind: 'remove'; then?: Pending; pay?: number; refund?: Refund }
  | { kind: 'swap'; card: string; then?: Pending; refund?: Refund }
  | { kind: 'treasure'; relic: string };

/** A shop purchase you can still back out of: its DP and the shop as it was. */
export interface Refund {
  dp: number;
  shop: Pending;
}

export interface RunSummary {
  date: number;
  daily?: string;
  starter: string;
  floor: number;
  wins: number;
  won: boolean;
  curse: number;
  fragments: number;
  /** played with an Anything goes deck (paid nothing) */
  open?: boolean;
}

// ---------- who you meet on each floor ----------
const regularsOf = (from: number, to: number) => CHAPTERS.filter((c) => c.n >= from && c.n <= to && !c.postgame).flatMap((c) => c.nodes.filter((n) => !n.boss && !n.story).map((n) => n.duelist));
const bossesOf = (from: number, to: number) => CHAPTERS.filter((c) => c.n >= from && c.n <= to && !c.postgame).flatMap((c) => c.nodes.filter((n) => n.boss));
/** Chapters whose regular duelists fill each floor. */
const FLOOR_CHAPTERS: [number, number][] = [
  [1, 2],
  [3, 5],
  [6, 7],
];
/** Who guards each floor, and who the tougher elite duels come from. */
const floorBosses = (f: number) => (f === 0 ? bossesOf(1, 2) : f === 1 ? bossesOf(4, 5) : bossesOf(6, 7));
const floorElites = (f: number) => (f === 0 ? regularsOf(3, 3) : f === 1 ? bossesOf(2, 3).map((n) => n.duelist) : bossesOf(4, 6).map((n) => n.duelist));

export function duelistById(id: string): CpuDuelist | undefined {
  for (const c of CHAPTERS) for (const n of c.nodes) if (n.duelist.id === id) return n.duelist;
  return undefined;
}

function conditionOf(id: string): DuelCondition | undefined {
  for (const c of CHAPTERS) for (const n of c.nodes) if (n.duelist.id === id) return n.condition;
  return undefined;
}

/** Cards you can be offered on a floor: everything in that floor's decks. */
export function floorPool(floor: number): string[] {
  const [a, b] = FLOOR_CHAPTERS[Math.min(2, floor)];
  const decks = CHAPTERS.filter((c) => c.n >= a && c.n <= b).flatMap((c) => c.nodes.map((n) => n.duelist));
  return [...new Set(decks.flatMap((d) => [...expand(d.main), ...expand(d.extra)]))];
}

// ---------- events ----------
export interface RunEvent {
  id: string;
  title: string;
  who: string;
  art: string;
  text: string;
  choices: { label: string; note: string }[];
}

export const EVENTS: RunEvent[] = [
  { id: 'pegasus', title: "Pegasus's Wager", who: 'Maximillion Pegasus', art: 'Toon World', text: '"A little game, Duelist-boy? Start your next duel with only 2000 Life Points. Win, and a treasure is yours."', choices: [{ label: 'Accept the wager', note: 'next duel at 2000 LP; win it for a relic' }, { label: 'Walk away', note: 'nothing happens' }] },
  { id: 'grandpa', title: "Grandpa's Game Shop", who: 'Solomon Muto', art: 'Kuriboh', text: '"I saved something special for you, from the back of the shop."', choices: [{ label: 'Take the gift', note: 'a free card from the next floor' }, { label: 'Ask for Duel Points', note: '+40 Duel Points' }] },
  { id: 'ring', title: 'The Thief King', who: 'Yami Bakura', art: 'Dark Necrofear', text: '"Your soul for a trinket. A fair trade, wouldn\'t you say?"', choices: [{ label: 'Trade a heart', note: 'lose 1 heart, gain a relic' }, { label: 'Refuse', note: 'nothing happens' }] },
  { id: 'graveyard', title: 'The Card Graveyard', who: 'Bonz', art: 'Call of the Haunted', text: 'Discarded cards lie everywhere. Some of them still hum with power.', choices: [{ label: 'Bury a card', note: 'remove a card from your deck, +20 Duel Points' }, { label: 'Dig for one', note: 'a random card from this floor' }] },
  { id: 'mai', title: "Mai's Perfume", who: 'Mai Valentine', art: 'Harpie Lady', text: '"I\'ll distract your next opponent. Don\'t make me regret it."', choices: [{ label: 'Accept', note: 'next opponent starts at 3000 LP' }, { label: 'Decline', note: '+15 Duel Points' }] },
  { id: 'shadi', title: "Shadi's Scales", who: 'Shadi', art: 'Spirit of the Pharaoh', text: '"Your heart will be weighed. Is it lighter than a feather?"', choices: [{ label: 'Be judged', note: 'a coin toss: a Millennium relic, or lose a heart' }, { label: 'Bow and leave', note: 'nothing happens' }] },
  { id: 'tea', title: 'Friendship Speech', who: 'Téa Gardner', art: 'Dark Magician Girl', text: '"You don\'t have to do this alone! Here, take this for the road."', choices: [{ label: 'Thank her', note: 'a heart back (or +30 Duel Points at full hearts)' }, { label: 'Ask for a card', note: 'a card from the next floor' }] },
  { id: 'tristan', title: 'Tristan\'s Shortcut', who: 'Tristan Taylor', art: 'Cyber Commander', text: '"I know a shortcut. Probably. Mostly. Trust me!"', choices: [{ label: 'Follow him', note: 'next opponent starts at 3000 LP, but you start at 3500' }, { label: 'Stay on the path', note: '+10 Duel Points' }] },
  { id: 'duke', title: 'Dungeon Dice', who: 'Duke Devlin', art: 'Orgoth the Relentless', text: '"Roll me for it. Double or nothing on your Duel Points."', choices: [{ label: 'Roll the dice', note: 'a coin toss: double your Duel Points or lose them' }, { label: 'Pass', note: 'nothing happens' }] },
  { id: 'rebecca', title: 'Rebecca\'s Deck Check', who: 'Rebecca Hawkins', art: 'White Magician Pikeru', text: '"Your deck is a mess! Let me fix it. Grandpa taught me."', choices: [{ label: 'Let her', note: 'cut 2 cards from your deck' }, { label: 'No way', note: '+15 Duel Points' }] },
  { id: 'noah', title: 'Virtual World Glitch', who: 'Noah Kaiba', art: 'Shinato, King of a Higher Plane', text: 'The walls flicker. A data stream offers to copy something you already have.', choices: [{ label: 'Copy a card', note: 'one more copy of a random card in your deck' }, { label: 'Walk on', note: 'nothing happens' }] },
  { id: 'kaiba', title: 'Kaiba Corp Prototype', who: 'Seto Kaiba', art: 'Blue-Eyes White Dragon', text: '"Test my new Duel Disk. If it explodes, that\'s your problem."', choices: [{ label: 'Try it', note: 'next duel: draw 2 more for your opening hand, but start at 3000 LP' }, { label: 'No thanks', note: 'nothing happens' }] },
];
export const eventById = (id: string) => EVENTS.find((e) => e.id === id)!;

// ---------- Curses ----------
export const CURSES = [
  'Opponents start with 500 more LP',
  'Elite duels are more common',
  'Shops cost 25% more',
  'Bosses start with 1000 more LP',
  'One fewer card to choose from after a win',
  'Start the run with 2 hearts',
  'Opponents draw one more card for their opening hand',
  'Rest stops heal nothing (they only cut cards)',
  'Opponents start with another 500 more LP',
  'Bosses start with a monster on the field',
];
export const cursed = (r: Run, n: number) => r.curse >= n;

// ---------- upgrades bought with Soul Fragments ----------
export const UPGRADES: { id: string; name: string; text: string; price: number }[] = [
  { id: 'heart', name: 'Extra Heart', text: 'Start every run with one more heart.', price: 80 },
  { id: 'dp', name: 'Pocket Money', text: 'Start every run with 50 Duel Points.', price: 40 },
  { id: 'draft', name: 'Keen Eye', text: 'See one more card when you pick after a win.', price: 60 },
  { id: 'relic', name: 'Lucky Charm', text: 'Start every run with a random relic.', price: 120 },
  { id: 'lp', name: 'Thick Skin', text: 'Start every duel in a run with 300 more LP.', price: 70 },
  { id: 'merchant', name: 'Regular Customer', text: 'Shops cost 15% less.', price: 90 },
  { id: 'secondwind', name: 'Second Wind', text: 'A heart back whenever you win a Millennium relic.', price: 110 },
  { id: 'scout', name: 'Duelist Scout', text: 'Start every run with an extra card from floor 2 in your deck.', price: 150 },
];

// ---------- making a run ----------
const PRICES = { card: 45, rare: 75, remove: 50, heal: 60, relic: 110 };

function hashText(t: string): number {
  let h = 2166136261;
  for (let i = 0; i < t.length; i++) h = Math.imul(h ^ t.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const dailySeed = (date: string) => hashText(`labyrinth-${date}`);
export const todayString = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
/** The Daily Labyrinth's starter: picked by the date so both brothers start the same. */
export const dailyStarter = (date: string) => STARTERS[dailySeed(date) % STARTERS.length].character;

function makeFloor(next: () => number, floor: number, curse: number): Floor {
  const ROWS = 6;
  const rows: Stop[][] = [];
  const regulars = regularsOf(...FLOOR_CHAPTERS[floor]);
  const bosses = floorBosses(floor);
  const elitePool = floorElites(floor);
  const pickOf = <T,>(a: T[]) => a[Math.floor(next() * a.length)];
  const eliteOdds = curse >= 2 ? 0.2 : 0.12;
  const usedFoes = new Set<string>();
  const usedEvents = new Set<string>();
  const foe = (list: CpuDuelist[]) => {
    const fresh = list.filter((d) => !usedFoes.has(d.id));
    const d = pickOf(fresh.length ? fresh : list);
    usedFoes.add(d.id);
    return d.id;
  };
  // At most two Card Shops a floor.
  let shops = 0;
  for (let r = 0; r < ROWS; r++) {
    const width = r === ROWS - 1 ? 1 : r === 0 ? 2 : 2 + Math.floor(next() * 2);
    const row: Stop[] = [];
    for (let c = 0; c < width; c++) {
      let kind: StopKind;
      if (r === ROWS - 1) kind = 'boss';
      else if (r === 0) kind = 'duel';
      else if (r === ROWS - 2) kind = c === 0 ? 'rest' : next() < 0.5 ? 'shop' : 'duel';
      else {
        const x = next();
        kind = x < eliteOdds ? 'elite' : x < 0.5 ? 'duel' : x < 0.62 ? 'shop' : x < 0.8 ? 'event' : x < 0.9 ? 'treasure' : 'rest';
      }
      if (kind === 'shop' && ++shops > 2) kind = 'duel';
      const stop: Stop = { id: `f${floor}r${r}c${c}`, kind, row: r, col: c, next: [] };
      if (kind === 'duel') stop.foe = foe(regulars);
      if (kind === 'elite') stop.foe = foe(elitePool);
      if (kind === 'boss') stop.foe = pickOf(bosses).duelist.id;
      if (kind === 'event') {
        const fresh = EVENTS.filter((ev) => !usedEvents.has(ev.id));
        stop.event = pickOf(fresh.length ? fresh : EVENTS).id;
        usedEvents.add(stop.event);
      }
      row.push(stop);
    }
    rows.push(row);
  }
  // Paths: each stop leads to the stop(s) nearest it on the next row; every stop is reachable.
  for (let r = 0; r < ROWS - 1; r++) {
    const a = rows[r];
    const b = rows[r + 1];
    for (const s of a) {
      const pos = a.length === 1 ? 0.5 : s.col / (a.length - 1);
      const near = b.length === 1 ? 0 : Math.round(pos * (b.length - 1));
      s.next.push(b[near].id);
      if (b.length > 1 && next() < 0.45) {
        const other = near + (next() < 0.5 ? -1 : 1);
        if (other >= 0 && other < b.length && !s.next.includes(b[other].id)) s.next.push(b[other].id);
      }
    }
    for (const t of b) if (!a.some((s) => s.next.includes(t.id))) a[Math.min(a.length - 1, Math.round((t.col / Math.max(1, b.length - 1)) * (a.length - 1)))].next.push(t.id);
  }
  return { rows };
}

export interface NewRunOptions {
  starter: string;
  seed: number;
  curse: number;
  upgrades: string[];
  daily?: string;
  /** a Millennium Item earned on the Road, carried in as a starting relic */
  bring?: string;
  /** start from one of your own decks instead of a Starter Deck (not in the Daily) */
  deck?: { name: string; main: string[]; extra: string[]; skill: string | null; open?: boolean };
}

export function newRun(o: NewRunOptions): Run {
  // The Daily is the same run for everyone: no upgrades, no carried Item, Curse 0.
  if (o.daily) o = { ...o, upgrades: [], curse: 0, bring: undefined, deck: undefined };
  const next = rng(o.seed);
  const st = STARTERS.find((s) => s.character === o.starter) ?? STARTERS[0];
  const d = o.deck ? { main: [...o.deck.main], extra: [...o.deck.extra], skill: o.deck.skill } : deckFromStarter(st);
  const floors = [0, 1, 2].map((f) => makeFloor(next, f, o.curse));
  let hearts = 3 + (o.upgrades.includes('heart') ? 1 : 0);
  if (o.curse >= 6) hearts -= 1;
  const relics: string[] = [];
  if (o.upgrades.includes('relic')) relics.push(COMMON_RELICS[Math.floor(next() * COMMON_RELICS.length)]);
  if (o.bring && relic(o.bring)?.millennium) relics.push(o.bring);
  // Duelist Scout: one card from floor 2's decks joins the starting deck.
  const scouted = (() => {
    if (!o.upgrades.includes('scout')) return null;
    const pool = floorPool(1).filter((n) => !floorExtra.has(n) && card(n)?.kind === 'monster');
    return pool.length ? pool[Math.floor(next() * pool.length)] : null;
  })();
  const run: Run = {
    id: `run${o.seed.toString(36)}${Date.now().toString(36)}`,
    seed: o.seed,
    daily: o.daily,
    starter: o.deck ? o.deck.name : st.character,
    ...(o.deck ? { ownDeck: true } : {}),
    ...(o.deck?.open ? { open: true } : {}),
    main: scouted && d.main.length < MAIN_MAX ? [...d.main, scouted] : d.main,
    extra: d.extra,
    skill: d.skill,
    hearts,
    maxHearts: hearts,
    dp: 30 + (o.upgrades.includes('dp') ? 50 : 0),
    relics,
    curse: o.curse,
    floors,
    floor: 0,
    at: null,
    visited: [],
    wins: 0,
    step: 0,
  };
  for (const r of relics) Object.assign(run, gainRelicStats(run, r));
  return run;
}

// ---------- moving through the map ----------
export function stopById(r: Run, id: string): Stop | undefined {
  for (const f of r.floors) for (const row of f.rows) for (const s of row) if (s.id === id) return s;
  return undefined;
}

/** Stops you can step onto next. */
export function reachable(r: Run): Stop[] {
  if (r.over || r.pending || r.inDuel) return [];
  const rows = r.floors[r.floor].rows;
  if (!r.at || !r.at.startsWith(`f${r.floor}`)) return rows[0];
  const here = stopById(r, r.at);
  if (!here) return rows[0];
  return here.next.map((id) => stopById(r, id)!).filter(Boolean);
}

/** A random stream for one step of the run, so reloading never rerolls. */
const stepRng = (r: Run, salt: number) => rng((r.seed ^ Math.imul(r.step + 1, 2654435761) ^ salt) >>> 0);

function draftSize(r: Run, upgrades: string[]): number {
  let n = 3 + (upgrades.includes('draft') ? 1 : 0);
  for (const name of r.relics) n += relic(name)?.draftPlus ?? 0;
  if (cursed(r, 5)) n -= 1;
  return Math.max(2, n);
}

/** Cards that can't do anything in a run deck (no way to summon them), never offered:
 * Ritual monsters, Toons (they need Toon World), and anything that can't be Normal Summoned. */
const DEAD_NAMES = new Set(['Gate Guardian', 'Polymerization']);
export function unplayableInRun(n: string): boolean {
  if (DEAD_NAMES.has(n)) return true;
  const c = card(n);
  if (c?.kind === 'spell' && c.sub === 'Ritual') return true;
  if (!c || c.kind !== 'monster') return false;
  return c.sub === 'Ritual' || /Toon World/.test(c.desc) || /cannot be Normal Summoned/i.test(c.desc);
}

function draftOptions(r: Run, upgrades: string[], floor: number, better = false): string[] {
  const next = stepRng(r, 7);
  const pool = floorPool(Math.min(2, floor + (better ? 1 : 0))).filter((n) => !unplayableInRun(n) && !floorExtra.has(n) && [...r.main, ...r.extra].filter((x) => x === n).length < COPIES);
  const out: string[] = [];
  const size = draftSize(r, upgrades);
  for (let guard = 0; out.length < size && guard < 200; guard++) {
    const n = pool[Math.floor(next() * pool.length)];
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

function shopItems(r: Run, upgrades: string[]): ShopItem[] {
  const next = stepRng(r, 11);
  let mult = 1 + (cursed(r, 3) ? 0.25 : 0);
  for (const name of r.relics) mult -= (relic(name)?.discount ?? 0) / 100;
  if (upgrades.includes('merchant')) mult -= 0.15;
  const price = (p: number) => Math.round((p * mult) / 5) * 5;
  const cards = draftOptions(r, upgrades, r.floor, true).slice(0, 2).concat(draftOptions({ ...r, step: r.step + 50 }, upgrades, r.floor).slice(0, 2));
  const items: ShopItem[] = [...new Set(cards)].map((name, i) => ({ kind: 'card' as const, name, price: price(i < 2 ? PRICES.rare : PRICES.card) }));
  const unowned = COMMON_RELICS.filter((x) => !r.relics.includes(x));
  if (unowned.length) items.push({ kind: 'relic', name: unowned[Math.floor(next() * unowned.length)], price: price(PRICES.relic) });
  items.push({ kind: 'remove', price: price(PRICES.remove) }, { kind: 'heal', price: price(PRICES.heal) });
  return items;
}

function gainRelicStats(r: Run, name: string): Partial<Run> {
  const rl = relic(name);
  if (!rl?.hearts) return {};
  return { maxHearts: r.maxHearts + rl.hearts, hearts: r.hearts + rl.hearts };
}

function withRelic(r: Run, name: string): Run {
  if (r.relics.includes(name)) return r;
  return { ...r, relics: [...r.relics, name], ...gainRelicStats(r, name) };
}

function randomRelic(r: Run, salt: number, millennium = false): string {
  const next = stepRng(r, salt);
  const pool = (millennium ? MILLENNIUM : COMMON_RELICS).filter((x) => !r.relics.includes(x));
  const all = pool.length ? pool : COMMON_RELICS;
  return all[Math.floor(next() * all.length)];
}

/** Step onto a stop. Duels wait for the duel; everything else opens its choice. */
export function enter(r: Run, stopId: string, upgrades: string[]): Run {
  const s = stopById(r, stopId);
  if (!s || !reachable(r).some((x) => x.id === stopId)) return r;
  const base: Run = { ...r, at: s.id, visited: [...r.visited, s.id], step: r.step + 1 };
  switch (s.kind) {
    case 'duel':
    case 'elite':
    case 'boss':
      return { ...base, inDuel: s.id };
    case 'shop':
      return { ...base, pending: { kind: 'shop', items: shopItems(base, upgrades) } };
    case 'event':
      return { ...base, pending: { kind: 'event', event: s.event! } };
    case 'rest':
      return { ...base, pending: { kind: 'rest' } };
    case 'treasure':
      return { ...base, pending: { kind: 'treasure', relic: randomRelic(base, 3) } };
  }
}

/** How the run's current duel starts: the foe, their deck and both sides' Duel Conditions. */
export function duelFor(r: Run, upgrades: string[]): { foe: CpuDuelist; me: SeatSetup; cpu: SeatSetup; notes: string[] } | null {
  const s = r.inDuel ? stopById(r, r.inDuel) : null;
  const foe = s?.foe ? duelistById(s.foe) : undefined;
  if (!s || !foe) return null;
  const notes: string[] = [];
  const meParts: (SeatSetup | undefined)[] = r.relics.map((n) => relic(n)?.me);
  const cpuParts: (SeatSetup | undefined)[] = r.relics.map((n) => relic(n)?.cpu);
  if (upgrades.includes('lp')) meParts.push({ lp: 4300 });
  // Only floor 3's elites and boss bring their Duel Condition: a young run deck needs a chance.
  if ((s.kind === 'elite' || s.kind === 'boss') && r.floor > 1) {
    const cond = conditionOf(foe.id);
    if (cond) {
      meParts.push(cond.player);
      cpuParts.push(cond.cpu);
      notes.push(cond.text);
    }
  }
  if (cursed(r, 1)) cpuParts.push({ lp: 4500 });
  if (cursed(r, 9)) cpuParts.push({ lp: 4500 });
  if (cursed(r, 4) && s.kind === 'boss') cpuParts.push({ lp: 5000 });
  if (cursed(r, 7)) cpuParts.push({ openingHand: 1 });
  if (cursed(r, 10) && s.kind === 'boss') {
    const d = deckOf(foe);
    const big = d.main.filter((n) => card(n)?.kind === 'monster' && (card(n)?.level ?? 0) <= 4).sort((a, b) => (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0))[0];
    if (big) cpuParts.push({ monsters: [big] });
  }
  if (r.nextDuel) {
    meParts.push(r.nextDuel.me);
    cpuParts.push(r.nextDuel.cpu);
    notes.push(r.nextDuel.text);
  }
  return { foe, me: mergeSetups(meParts), cpu: mergeSetups(cpuParts), notes };
}

/** The duel is starting: from now on, closing the app counts as losing it. */
export const stake = (r: Run): Run => (r.inDuel ? { ...r, staked: true } : r);

/** Writes a run duel's result. A loss costs a heart; a win opens the card pick. */
export function afterDuel(r: Run, result: 'w' | 'l' | 'd', upgrades: string[]): Run {
  const s = r.inDuel ? stopById(r, r.inDuel) : null;
  if (!s) return r;
  const base: Run = { ...r, inDuel: undefined, staked: undefined, step: r.step + 1 };
  if (result !== 'w') {
    const hearts = r.hearts - 1;
    // A lost wager is gone; any other boon waits for the next duel.
    const nextDuel = r.nextDuel?.prize ? undefined : r.nextDuel;
    // A lost duel still moves you on (no retrying the same foe), unless the run is over.
    if (hearts <= 0) return { ...base, hearts: 0, over: 'lost', nextDuel: undefined };
    if (s.kind === 'boss') return { ...base, hearts, inDuel: s.id, nextDuel };
    return { ...base, hearts, nextDuel };
  }
  let dp = s.kind === 'boss' ? 80 : s.kind === 'elite' ? 50 : 30;
  for (const n of r.relics) dp += relic(n)?.dp ?? 0;
  // A won wager pays its relic straight away, so an elite's or boss's relic can't crowd it out.
  const prize = r.nextDuel?.prize === 'relic' ? randomRelic(base, 5) : undefined;
  const heal = s.kind === 'boss' && r.relics.some((n) => relic(n)?.bossHeal);
  const withPrize = prize ? withRelic(base, prize) : base;
  const millennium = s.kind === 'boss' || s.kind === 'elite' ? randomRelic(withPrize, 9, s.kind === 'boss') : prize;
  const won: Run = { ...withPrize, wins: r.wins + 1, nextDuel: undefined };
  return { ...won, pending: { kind: 'draft', options: draftOptions(won, upgrades, r.floor, s.kind !== 'duel'), dp, heal, relic: millennium } };
}

function finishFloorIfBoss(r: Run): Run {
  const s = r.at ? stopById(r, r.at) : null;
  if (!s || s.kind !== 'boss') return r;
  if (r.floor >= 2) return { ...r, over: 'won' };
  return { ...r, floor: r.floor + 1 };
}

/** The deck is full (30): a new card has to replace one. */
const deckFull = (r: Run) => r.main.length >= MAIN_MAX;
const isExtra = (r: Run, name: string) => floorExtra.has(name);
const floorExtra = new Set(CHAPTERS.flatMap((c) => c.nodes.flatMap((n) => expand(n.duelist.extra))));

/** Takes a card into the run deck (or opens the swap when the deck is full). */
function addCard(r: Run, name: string, then?: Pending): Run {
  if (isExtra(r, name)) return r.extra.length < 6 ? { ...r, extra: [...r.extra, name], pending: then } : { ...r, pending: then };
  if (deckFull(r)) return { ...r, pending: { kind: 'swap', card: name, then } };
  return { ...r, main: [...r.main, name], pending: then };
}

export type Choice =
  | { kind: 'draft'; pick: string | null }
  | { kind: 'buy'; index: number }
  | { kind: 'leave' }
  | { kind: 'event'; option: number }
  | { kind: 'rest'; option: 'heal' | 'cut' }
  | { kind: 'remove'; card: string | null }
  | { kind: 'swap'; out: string | null }
  | { kind: 'treasure' };

/** Answers whatever the run is waiting on. */
export function choose(r: Run, c: Choice, upgrades: string[]): Run {
  const p = r.pending;
  if (!p) return r;
  const done = (x: Run): Run => finishFloorIfBoss({ ...x, step: x.step + 1 });
  switch (p.kind) {
    case 'draft': {
      if (c.kind !== 'draft') return r;
      let x: Run = { ...r, dp: r.dp + p.dp, pending: undefined };
      if (p.heal) x.hearts = Math.min(x.maxHearts, x.hearts + 1);
      if (p.relic) x = withRelic(x, p.relic);
      if (upgrades.includes('secondwind') && relic(p.relic ?? '')?.millennium) x.hearts = Math.min(x.maxHearts, x.hearts + 1);
      if (c.pick) x = addCard(x, c.pick);
      return x.pending ? x : done(x);
    }
    case 'shop': {
      if (c.kind === 'leave') return done({ ...r, pending: undefined });
      if (c.kind !== 'buy') return r;
      const it = p.items[c.index];
      if (!it || it.sold || r.dp < it.price) return r;
      if (it.kind === 'heal' && r.hearts >= r.maxHearts) return r;
      const items = p.items.map((x, i) => (i === c.index ? { ...x, sold: true } : x));
      const shop: Pending = { kind: 'shop', items };
      const paid: Run = { ...r, dp: r.dp - it.price, pending: shop };
      // Backing out of the swap or the removal gives the DP back and puts the item back on the shelf.
      const refund: Refund = { dp: it.price, shop: p };
      if (it.kind === 'card') {
        const y = addCard(paid, it.name!, shop);
        return y.pending?.kind === 'swap' ? { ...y, pending: { ...y.pending, refund } } : y;
      }
      if (it.kind === 'relic') return withRelic(paid, it.name!);
      if (it.kind === 'heal') return { ...paid, hearts: paid.hearts + 1 };
      return { ...paid, pending: { kind: 'remove', then: shop, refund } };
    }
    case 'event': {
      if (c.kind !== 'event') return r;
      const x: Run = { ...r, pending: undefined };
      const accept = c.option === 0;
      switch (p.event) {
        case 'pegasus':
          return done(accept ? { ...x, nextDuel: { me: { lp: 2000 }, text: "Pegasus's Wager: you start at 2000 LP", prize: 'relic' } } : x);
        case 'grandpa': {
          if (!accept) return done({ ...x, dp: x.dp + 40 });
          const gift = draftOptions(x, upgrades, x.floor, true)[0];
          const y = gift ? addCard(x, gift) : x;
          return y.pending ? y : done(y);
        }
        case 'ring':
          return done(accept && x.hearts > 1 ? withRelic({ ...x, hearts: x.hearts - 1 }, randomRelic(x, 13)) : x);
        case 'graveyard': {
          // Nothing to bury at 20 cards, so nothing is paid.
          if (accept) return x.main.length > 20 ? { ...x, pending: { kind: 'remove', pay: 20 } } : done(x);
          const dug = draftOptions(x, upgrades, x.floor)[0];
          const y = dug ? addCard(x, dug) : x;
          return y.pending ? y : done(y);
        }
        case 'mai':
          return done(accept ? { ...x, nextDuel: { cpu: { lp: 3000 }, text: "Mai's Perfume: your opponent starts at 3000 LP" } } : { ...x, dp: x.dp + 15 });
        case 'kaiba':
          return done(accept ? { ...x, nextDuel: { me: { openingHand: 2, lp: 3000 }, text: 'Kaiba Corp Prototype: 2 extra cards, 3000 LP' } } : x);
        case 'shadi': {
          if (!accept || x.hearts <= 1) return done(x);
          const heads = stepRng(x, 17)() < 0.5;
          if (heads) return done(withRelic(x, randomRelic(x, 19, true)));
          const hearts = x.hearts - 1;
          return done(hearts <= 0 ? { ...x, hearts: 0, over: 'lost' } : { ...x, hearts });
        }
        case 'tea':
          if (!accept) {
            const gift = draftOptions(x, upgrades, x.floor, true)[0];
            const y = gift ? addCard(x, gift) : x;
            return y.pending ? y : done(y);
          }
          return done(x.hearts < x.maxHearts ? { ...x, hearts: x.hearts + 1 } : { ...x, dp: x.dp + 30 });
        case 'tristan':
          return done(accept ? { ...x, nextDuel: { me: { lp: 3500 }, cpu: { lp: 3000 }, text: "Tristan's Shortcut: you 3500 LP, them 3000" } } : { ...x, dp: x.dp + 10 });
        case 'duke':
          if (!accept) return done(x);
          return done(stepRng(x, 23)() < 0.5 ? { ...x, dp: x.dp * 2 } : { ...x, dp: 0 });
        case 'rebecca':
          if (!accept) return done({ ...x, dp: x.dp + 15 });
          return { ...x, pending: { kind: 'remove', then: { kind: 'remove' } } };
        case 'noah': {
          if (!accept) return done(x);
          const can = [...new Set(x.main)].filter((n) => x.main.filter((m) => m === n).length < COPIES);
          const pick = can[Math.floor(stepRng(x, 29)() * can.length)];
          const y = pick ? addCard(x, pick) : x;
          return y.pending ? y : done(y);
        }
      }
      return done(x);
    }
    case 'rest': {
      // Nothing to do here (hearts full or cursed, deck at 20): just move on.
      if (c.kind === 'leave') return done({ ...r, pending: undefined });
      if (c.kind !== 'rest') return r;
      if (c.option === 'heal' && !cursed(r, 8)) return done({ ...r, pending: undefined, hearts: Math.min(r.maxHearts, r.hearts + 1) });
      return { ...r, pending: { kind: 'remove' } };
    }
    case 'remove': {
      if (c.kind !== 'remove') return r;
      if (!c.card && p.refund) return { ...r, dp: r.dp + p.refund.dp, pending: p.refund.shop };
      let x: Run = { ...r, pending: p.then };
      if (c.card) {
        // The Graveyard's payment comes only when a card is really buried.
        if (p.pay && x.main.includes(c.card) && x.main.length > 20) x = { ...x, dp: x.dp + p.pay };
        if (x.main.includes(c.card) && x.main.length > 20) {
          const i = x.main.indexOf(c.card);
          x = { ...x, main: [...x.main.slice(0, i), ...x.main.slice(i + 1)] };
        } else if (x.extra.includes(c.card)) {
          const i = x.extra.indexOf(c.card);
          x = { ...x, extra: [...x.extra.slice(0, i), ...x.extra.slice(i + 1)] };
        }
      }
      return x.pending ? x : done(x);
    }
    case 'swap': {
      if (c.kind !== 'swap') return r;
      // Only a Main Deck card can make room; anything else is ignored.
      if (c.out && !r.main.includes(c.out)) return r;
      if (!c.out && p.refund) return { ...r, dp: r.dp + p.refund.dp, pending: p.refund.shop };
      let x: Run = { ...r, pending: p.then };
      if (c.out) {
        const i = x.main.indexOf(c.out);
        x = { ...x, main: [...x.main.slice(0, i), ...x.main.slice(i + 1), p.card] };
      }
      return x.pending ? x : done(x);
    }
    case 'treasure':
      return done(withRelic({ ...r, pending: undefined }, p.relic));
  }
}

/** Soul Fragments a finished run pays. */
export function fragmentsFor(r: Run): number {
  if (r.open) return 0;
  const floorsDone = r.over === 'won' ? 3 : r.floor;
  return r.wins * 3 + floorsDone * 15 + (r.over === 'won' ? 40 + r.curse * 10 : 0);
}

export function summaryOf(r: Run): RunSummary {
  return { date: Date.now(), daily: r.daily, starter: r.starter, floor: r.over === 'won' ? 3 : r.floor + 1, wins: r.wins, won: r.over === 'won', curse: r.curse, fragments: fragmentsFor(r), ...(r.open ? { open: true } : {}) };
}

/** A run better than another: further, then more wins. */
export const better = (a: RunSummary, b: RunSummary | null) => !b || a.floor * 100 + a.wins + (a.won ? 1000 : 0) > b.floor * 100 + b.wins + (b.won ? 1000 : 0);

// ---------- Daily result codes ----------
/** A 4-letter check so a result code can't just be typed up. */
function check(body: string): string {
  let h = 2166136261;
  for (const ch of `speed-realm:${body}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return (h >>> 0).toString(36).slice(-4).toUpperCase().padStart(4, '0');
}

/** A short code for a Daily Labyrinth result, to text your brother. */
export function resultCode(s: RunSummary, name: string): string {
  if (!s.daily) return '';
  const body = `DL-${s.daily.replace(/-/g, '')}-${s.won ? 'W' : 'F' + s.floor}-${s.wins}-${encodeURIComponent(name.slice(0, 16))}`;
  return `${body}.${check(body)}`;
}

export function readResultCode(code: string): { daily: string; won: boolean; floor: number; wins: number; name: string } | null {
  const full = code.trim();
  const dot = full.lastIndexOf('.');
  if (dot < 0 || check(full.slice(0, dot)) !== full.slice(dot + 1).toUpperCase()) return null;
  const m = full.slice(0, dot).match(/^DL-(\d{4})(\d{2})(\d{2})-(W|F(\d))-(\d+)-(.*)$/);
  if (!m) return null;
  try {
    return { daily: `${m[1]}-${m[2]}-${m[3]}`, won: m[4].toUpperCase() === 'W', floor: m[4].toUpperCase() === 'W' ? 3 : Number(m[5]), wins: Number(m[6]), name: decodeURIComponent(m[7]) || 'Your brother' };
  } catch {
    return null;
  }
}

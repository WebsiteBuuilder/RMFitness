// Duelist Requests: every day three characters each ask for something in a duel ("finish
// a duel with a Warrior", "destroy 3 monsters in one duel"). Doing it pays a card from
// that character's deck, picked from ones the profile doesn't own yet; doing all three
// in a day also pays a pack. Only duels that count move a request on: the Millennium
// Road, the Duel Labyrinth, Duel the Computer and duels against another player, all with
// a collection deck. Practice, computer-vs-computer and "Anything goes" decks never do.
//
// Everyone gets the same three requests on the same day (they are picked from the date),
// so two brothers can race each other for them. Setting the clock back pays nothing until
// the real date passes the last day played, as with the other daily prizes.
import { card } from '../eds/db';
import { rng } from '../eds/rng';
import { STARTERS, deckFromStarter, owned, unplayableReason, withCards, COPIES, type SpeedSave } from '../eds/speedSave';
import { CHAPTERS } from '../eds/speedCampaign/roster';
import { expand } from '../eds/speedCampaign/campaign';
import type { DuelState, Pid } from '../eds/types';
import type { Deeds } from '../level/leveling';
import { dayKey, withPacks } from './economy';
import { RARITIES, rarityOf } from './sets';

/** A character who hands out requests: their deck is what a request pays from. */
export interface Giver {
  name: string;
  title: string;
  /** the card standing in for their portrait */
  face: string;
  deck: string[];
}

let givers: Giver[] | null = null;
/** Every Millennium Road duelist and every Starter Deck character, once each. */
export function allGivers(): Giver[] {
  if (givers) return givers;
  const out = new Map<string, Giver>();
  for (const s of STARTERS) {
    const d = deckFromStarter(s);
    const deck = [...d.main, ...d.extra];
    const old = out.get(s.character);
    if (old) old.deck.push(...deck);
    else out.set(s.character, { name: s.character, title: 'Starter Deck duelist', face: strongest(deck), deck });
  }
  for (const ch of CHAPTERS)
    for (const n of ch.nodes) {
      const u = n.duelist;
      if (out.has(u.name)) continue;
      out.set(u.name, { name: u.name, title: u.title, face: u.portrait, deck: [...expand(u.main), ...expand(u.extra)] });
    }
  givers = [...out.values()];
  return givers;
}
const strongest = (deck: string[]) => [...deck].sort((a, b) => (card(b)?.atk ?? -1) - (card(a)?.atk ?? -1))[0] ?? deck[0];
export const giverByName = (name: string) => allGivers().find((g) => g.name === name);

// ---------- what a duel did ----------

/** One profile's side of a finished duel, as far as requests care. */
export interface DuelSummary {
  won: boolean;
  /** the duel's turn count (both players' turns together) */
  turns: number;
  lpLeft: number;
  /** what each of this profile's cards did (card leveling's tally) */
  deeds: Record<string, Deeds>;
}

export function summaryOf(state: DuelState, seat: Pid): DuelSummary {
  const t = state.fx?.lvl as { s: [Record<string, Deeds>, Record<string, Deeds>] } | undefined;
  return { won: state.winner === seat, turns: state.turn, lpLeft: Math.max(0, state.players[seat].lp), deeds: t?.s[seat] ?? {} };
}

const sum = (d: Record<string, Deeds>, f: (x: Deeds, name: string) => number) => Object.entries(d).reduce((a, [n, x]) => a + f(x, n), 0);
const kindOf = (n: string) => card(n)?.kind;

// ---------- the requests ----------

export type ReqKind = 'finishRace' | 'kills' | 'killsDay' | 'direct' | 'lp' | 'fast' | 'attr' | 'spellTrap' | 'wins' | 'hits';

interface Template {
  kind: ReqKind;
  need: number;
  text: (arg: string) => string;
  /** how far this duel moves the request */
  amount: (s: DuelSummary, arg: string) => number;
  /** the request needs something from the giver's deck (a Type or an Attribute) */
  arg?: (g: Giver) => string | null;
}

/** The commonest monster Type (race) or Attribute in a deck. */
function commonest(deck: string[], key: 'race' | 'attribute'): string | null {
  const n: Record<string, number> = {};
  for (const name of deck) {
    const c = card(name);
    const v = c?.kind === 'monster' ? c[key] : undefined;
    if (v) n[v] = (n[v] ?? 0) + 1;
  }
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : null;
}

export const TEMPLATES: Template[] = [
  {
    kind: 'finishRace',
    need: 1,
    arg: (g) => commonest(g.deck, 'race'),
    text: (a) => `Win a duel with the final blow from a ${a} monster`,
    amount: (s, a) => (s.won && Object.entries(s.deeds).some(([n, d]) => d.f > 0 && card(n)?.kind === 'monster' && card(n)?.race === a) ? 1 : 0),
  },
  { kind: 'kills', need: 1, text: () => "Destroy 3 of your opponent's monsters in one duel", amount: (s) => (sum(s.deeds, (d) => d.k) >= 3 ? 1 : 0) },
  { kind: 'killsDay', need: 6, text: () => "Destroy 6 of your opponents' monsters today", amount: (s) => sum(s.deeds, (d) => d.k) },
  { kind: 'direct', need: 2000, text: () => 'Deal 2000 damage with direct attacks today', amount: (s) => sum(s.deeds, (d) => d.dd) },
  { kind: 'lp', need: 1, text: () => 'Win a duel with 3000 or more Life Points left', amount: (s) => (s.won && s.lpLeft >= 3000 ? 1 : 0) },
  { kind: 'fast', need: 1, text: () => 'Win a duel within 8 turns (both players’ turns together)', amount: (s) => (s.won && s.turns <= 8 ? 1 : 0) },
  {
    kind: 'attr',
    need: 5,
    arg: (g) => commonest(g.deck, 'attribute'),
    text: (a) => `Play ${a} monsters 5 times today (summons, sets and effects count)`,
    amount: (s, a) => sum(s.deeds, (d, n) => (card(n)?.kind === 'monster' && card(n)?.attribute === a ? d.p : 0)),
  },
  { kind: 'spellTrap', need: 6, text: () => 'Set or activate Spell and Trap cards 6 times today', amount: (s) => sum(s.deeds, (d, n) => (kindOf(n) === 'spell' || kindOf(n) === 'trap' ? d.p : 0)) },
  { kind: 'wins', need: 2, text: () => 'Win 2 duels today', amount: (s) => (s.won ? 1 : 0) },
  { kind: 'hits', need: 5, text: () => 'Hit with an attack that deals damage 5 times today', amount: (s) => sum(s.deeds, (d) => d.b + d.d) },
];
const template = (k: ReqKind) => TEMPLATES.find((t) => t.kind === k)!;

export interface Request {
  giver: string;
  kind: ReqKind;
  /** the Type or Attribute it names, if any */
  arg: string;
  need: number;
  have: number;
  done: boolean;
  /** the card it paid */
  reward?: string;
}

export interface Board {
  day: string;
  list: Request[];
  /** the all-three pack was paid */
  bonus: boolean;
  /** today's one swap was used */
  swapped: boolean;
  /** how many requests have been dealt today (a swap deals the next one) */
  dealt: number;
}

/** Requests a day, and how many swaps a day. */
export const PER_DAY = 3;

type ReqSave = SpeedSave & { requests?: Board };
export const requestText = (r: Request) => template(r.kind).text(r.arg);

/** The day's requests, in the order they are dealt (the same on every phone). */
function deal(day: string, n: number): Request[] {
  const seed = [...day].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0, 0x5eed);
  const next = rng(seed);
  const gs = [...allGivers()];
  const ts = [...TEMPLATES];
  const out: Request[] = [];
  const usedT = new Set<ReqKind>();
  const usedG = new Set<string>();
  for (let tries = 0; out.length < n && tries < 400; tries++) {
    const g = gs[Math.floor(next() * gs.length)];
    const t = ts[Math.floor(next() * ts.length)];
    if (usedG.has(g.name) || usedT.has(t.kind)) continue;
    const arg = t.arg ? t.arg(g) : '';
    if (arg === null) continue;
    if (!rewardPool(g).length) continue;
    usedG.add(g.name);
    // Every kind once before any repeats (swaps can run long).
    usedT.add(t.kind);
    if (usedT.size === ts.length) usedT.clear();
    out.push({ giver: g.name, kind: t.kind, arg, need: t.need, have: 0, done: false });
  }
  return out;
}

const playable = (n: string) => {
  const c = card(n);
  return !!c && !!c.speed && c.sub !== 'Skill' && !unplayableReason(n);
};
/** What a giver's request can pay: their deck's cards up to Super Rare (so a request is a nice card, never a fortune). */
export function rewardPool(g: Giver): string[] {
  return [...new Set(g.deck)].filter((n) => playable(n) && RARITIES.indexOf(rarityOf(n)) <= RARITIES.indexOf('Super Rare'));
}

/** The card a finished request pays: one the profile doesn't own, else one it has fewest of (under 3). */
export function pickReward(s: SpeedSave, g: Giver, seed: number): string | null {
  const pool = rewardPool(g).filter((n) => owned(s, n) < COPIES);
  if (!pool.length) return null;
  const fewest = Math.min(...pool.map((n) => owned(s, n)));
  const best = pool.filter((n) => owned(s, n) === fewest).sort();
  return best[Math.floor(rng(seed)() * best.length)];
}

/** Today's board: null when the phone's clock reads earlier than a day already played. */
export function boardOf(s: SpeedSave, now = Date.now()): Board | null {
  const today = dayKey(now);
  const b = (s as ReqSave).requests;
  if (b && b.day === today) return b;
  if (b && b.day > today) return null;
  return { day: today, list: deal(today, PER_DAY), bonus: false, swapped: false, dealt: PER_DAY };
}

export const withBoard = (s: SpeedSave, b: Board): SpeedSave => ({ ...s, requests: b }) as ReqSave;

/** Trades one request nobody has started for the next one, once a day. */
export function swapRequest(s: SpeedSave, i: number, now = Date.now()): SpeedSave | null {
  const b = boardOf(s, now);
  if (!b || b.swapped || !b.list[i] || b.list[i].done || b.list[i].have > 0) return null;
  const others = new Set(b.list.map((r) => r.giver));
  const kinds = new Set(b.list.map((r) => r.kind));
  const fresh = deal(b.day, b.dealt + 12)
    .slice(b.dealt)
    .find((r) => !others.has(r.giver) && !kinds.has(r.kind));
  if (!fresh) return null;
  const list = b.list.map((r, j) => (j === i ? fresh : r));
  return withBoard(s, { ...b, list, swapped: true, dealt: b.dealt + 1 });
}

export interface RequestNews {
  save: SpeedSave;
  lines: string[];
  /** cards the requests paid */
  cards: string[];
}

/**
 * A duel that counts finished: moves today's requests on and pays any that are done.
 * `counts` is false for Practice, computer-vs-computer and "Anything goes" decks.
 */
export function noteRequests(s: SpeedSave, sum: DuelSummary, counts: boolean, now = Date.now()): RequestNews {
  const b = boardOf(s, now);
  if (!counts || !b) return { save: s, lines: [], cards: [] };
  let save = s;
  const lines: string[] = [];
  const cards: string[] = [];
  const list = b.list.map((r, i) => {
    if (r.done) return r;
    const have = Math.min(r.need, r.have + template(r.kind).amount(sum, r.arg));
    if (have < r.need) return { ...r, have };
    const g = giverByName(r.giver);
    const reward = g ? pickReward(save, g, now + i * 7919) : null;
    if (reward) {
      save = withCards(save, [reward]);
      cards.push(reward);
      lines.push(`Request done for ${r.giver}: ${reward} is yours`);
    } else {
      save = withPacks(save, 1);
      lines.push(`Request done for ${r.giver}: you own every card they had to give, so here's a booster pack`);
    }
    return { ...r, have, done: true, reward: reward ?? undefined };
  });
  let bonus = b.bonus;
  if (!bonus && list.every((r) => r.done)) {
    bonus = true;
    save = withPacks(save, 1);
    lines.push("All of today's requests done: a booster pack");
  }
  return { save: withBoard(save, { ...b, list, bonus }), lines, cards };
}

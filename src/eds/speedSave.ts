// Speed Duel save data, kept apart from the EDS save: each profile has its own
// Speed Duel decks (any Speed Duel card, 3 copies each), a chosen Skill per deck and
// a Speed Duel record. Stored in localStorage under `eds.speed.<profile id>`.
import starterData from './data/speedDecks.json';
import limited from './data/speedLimited.json';
import { card } from './db';
import { hasEffect } from './effects';
import { getSkill } from './skills';

export interface SpeedDeck {
  id: string;
  name: string;
  main: string[];
  /** Extra Deck (Fusion Monsters) */
  extra: string[];
  skill: string | null;
}

export interface SpeedSave {
  version: 1;
  decks: SpeedDeck[];
  /** id of the deck used in duels */
  active: string | null;
  record: Record<string, { w: number; l: number; d: number }>;
  wins: number;
  losses: number;
  draws: number;
  created: number;
}

export const MAIN_MIN = 20;
export const MAIN_MAX = 30;
export const EXTRA_MAX = 6;
export const COPIES = 3;
export const MAX_DECKS = 12;

const key = (profileId: string) => `eds.speed.${profileId}`;
const mem = new Map<string, SpeedSave>();

export function newSpeedSave(): SpeedSave {
  return { version: 1, decks: [], active: null, record: {}, wins: 0, losses: 0, draws: 0, created: Date.now() };
}

export function loadSpeedSave(profileId: string): SpeedSave {
  try {
    const raw = localStorage.getItem(key(profileId));
    const s = raw ? (JSON.parse(raw) as SpeedSave) : null;
    if (s && s.version === 1 && Array.isArray(s.decks)) return s;
  } catch {
    /* storage blocked: fall back to memory */
  }
  return mem.get(profileId) ?? newSpeedSave();
}

export function writeSpeedSave(profileId: string, s: SpeedSave) {
  mem.set(profileId, s);
  try {
    localStorage.setItem(key(profileId), JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

export function eraseSpeedSave(profileId: string) {
  mem.delete(profileId);
  try {
    localStorage.removeItem(key(profileId));
  } catch {
    /* ignore */
  }
}

export function activeDeck(s: SpeedSave): SpeedDeck | null {
  return s.decks.find((d) => d.id === s.active) ?? s.decks[0] ?? null;
}

export function newDeckId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** A copy of the save with one duel's result written in. */
export function withSpeedResult(s: SpeedSave, result: 'w' | 'l' | 'd', opp: string): SpeedSave {
  const next: SpeedSave = { ...s, record: { ...s.record } };
  const r = { ...(next.record[opp] ?? { w: 0, l: 0, d: 0 }) };
  r[result]++;
  next.record[opp] = r;
  if (result === 'w') next.wins++;
  else if (result === 'l') next.losses++;
  else next.draws++;
  return next;
}

// ---------- the card pool ----------
const EXTRA_KINDS = ['Fusion'];
const UNSUMMONABLE = ['Xyz', 'Synchro', 'Link'];

/** Why a Speed Duel card cannot go in a deck yet, or null when it can. */
export function unplayableReason(name: string): string | null {
  const c = card(name);
  if (!c || !c.speed) return 'not a Speed Duel card';
  if (UNSUMMONABLE.includes(c.sub)) return `${c.sub} Monsters can't be summoned in this game`;
  if (/Token/.test(c.name)) return 'a Token';
  if (c.vanilla) return null;
  if (!hasEffect(c.name)) return "its effect isn't in the game yet";
  return null;
}

export const isExtraCard = (name: string) => EXTRA_KINDS.includes(card(name)?.sub ?? '');

// ---------- the Limited List ----------
const FORBIDDEN = new Set<string>(limited.forbidden);
const GROUPS: { limit: number; names: Set<string> }[] = Object.entries(limited.limited).map(([n, names]) => ({ limit: Number(n), names: new Set(names as string[]) }));
export const LIMITED_LIST_NAME = limited.name;

/** The Limited List status of a card or Skill: 'Forbidden', 'Limited 1', 'Limited 2', 'Limited 3' or null. */
export function limitStatus(name: string): string | null {
  const base = name.replace(/ \(Skill Card\)$/, '');
  if (FORBIDDEN.has(base)) return 'Forbidden';
  for (const g of GROUPS) if (g.names.has(base)) return `Limited ${g.limit}`;
  return null;
}

/** Everything wrong with a deck, in the player's words (empty when it is ready to duel). */
export function speedDeckProblems(d: SpeedDeck): string[] {
  const out: string[] = [];
  if (d.main.length < MAIN_MIN || d.main.length > MAIN_MAX) out.push(`Main Deck needs ${MAIN_MIN} to ${MAIN_MAX} cards (${d.main.length} now)`);
  if (d.extra.length > EXTRA_MAX) out.push(`Extra Deck holds at most ${EXTRA_MAX} cards`);
  const counts: Record<string, number> = {};
  for (const n of [...d.main, ...d.extra]) counts[n] = (counts[n] ?? 0) + 1;
  for (const [n, c] of Object.entries(counts)) {
    if (c > COPIES) out.push(`Only ${COPIES} copies of ${n} allowed`);
    const why = unplayableReason(n);
    if (why) out.push(`${n}: ${why}`);
  }
  for (const n of d.main) if (isExtraCard(n)) out.push(`${n} belongs in the Extra Deck`);
  for (const n of d.extra) if (!isExtraCard(n)) out.push(`${n} can't go in the Extra Deck`);
  const all = [...d.main, ...d.extra, ...(d.skill ? [d.skill] : [])];
  for (const n of new Set(all)) if (FORBIDDEN.has(n)) out.push(`${n} is Forbidden`);
  for (const g of GROUPS) {
    const inGroup = all.filter((n) => g.names.has(n.replace(/ \(Skill Card\)$/, '')));
    if (inGroup.length > g.limit) out.push(`Limited ${g.limit}: only ${g.limit} card${g.limit > 1 ? 's' : ''} total from that group (${[...new Set(inGroup)].join(', ')})`);
  }
  if (d.skill && !getSkill(d.skill)) out.push(`The Skill ${d.skill} isn't in the game yet`);
  return [...new Set(out)];
}

// ---------- ready-made decks ----------
interface RawStarter {
  title: string;
  character: string;
  main: [string, number][];
  extra: [string, number][];
  skills: string[];
}

export interface Starter {
  title: string;
  character: string;
  main: string[];
  extra: string[];
  skills: string[];
}

const expand = (list: [string, number][]) => list.flatMap(([n, q]) => Array<string>(q).fill(n));
export const STARTERS: Starter[] = (starterData as RawStarter[]).map((s) => ({ title: s.title, character: s.character, main: expand(s.main), extra: expand(s.extra), skills: s.skills }));

/** The first of a starter's Skills the game can play (Skill names may carry " (Skill Card)"). */
export function starterSkill(s: Starter): string | null {
  for (const n of s.skills) {
    if (getSkill(n)) return n;
    if (getSkill(`${n} (Skill Card)`)) return `${n} (Skill Card)`;
  }
  return null;
}

/** A deck built from a starter, keeping only cards the game can play. */
export function deckFromStarter(s: Starter): SpeedDeck {
  return { id: newDeckId(), name: s.character, main: s.main.filter((n) => !unplayableReason(n)), extra: s.extra.filter((n) => !unplayableReason(n)), skill: starterSkill(s) };
}

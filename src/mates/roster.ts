// Mates: little companions that stand beside each player's field in a Speed Duel, like
// Master Duel's Mates. Purely for show: they never touch the duel. Every design here is
// original (drawn in MateArt.tsx), not a card's monster.
import type { SpeedSave } from '../eds/speedSave';
import { chipsOf } from '../collection/economy';
import { lessonsDone, LESSONS } from '../eds/tutorial';

export type MateId =
  | 'pip'
  | 'ember'
  | 'bolt'
  | 'sprout'
  | 'wisp'
  | 'pebble'
  | 'mimic'
  | 'hoot'
  | 'chill'
  | 'scarab'
  | 'sphinx'
  | 'gloop'
  | 'kitsu'
  | 'nova'
  | 'drake';

/** How a mate is had: free from the start, bought with Duel Chips, or earned. */
export type MateCost = { free: true } | { chips: number } | { wins: number } | { school: true };

export interface MateDef {
  id: MateId;
  name: string;
  /** one line for the Mates page */
  blurb: string;
  cost: MateCost;
  /** its voice: the pitch of its chirps (Hz) */
  voice: number;
  /** its reactions to a tap, picked at random */
  taps: MateReact[];
}

/** What a mate can do: a short animation with a face and a little symbol over its head. */
export type MateReact = 'wave' | 'hop' | 'spin' | 'cheer' | 'laugh' | 'wow' | 'hurt' | 'sad' | 'angry' | 'love' | 'sleep' | 'win' | 'lose';

/** The reactions anyone can send from the hold menu (both phones see them). */
export const EMOTES: { react: MateReact; label: string }[] = [
  { react: 'cheer', label: 'Cheer' },
  { react: 'laugh', label: 'Laugh' },
  { react: 'wow', label: 'Wow' },
  { react: 'love', label: 'Love' },
  { react: 'sad', label: 'Sad' },
  { react: 'angry', label: 'Angry' },
];

export const REACTS: readonly MateReact[] = ['wave', 'hop', 'spin', 'cheer', 'laugh', 'wow', 'hurt', 'sad', 'angry', 'love', 'sleep', 'win', 'lose'];

export const MATES: MateDef[] = [
  { id: 'pip', name: 'Pip', blurb: 'A fluffball who bounces when it is happy (which is always).', cost: { free: true }, voice: 880, taps: ['hop', 'wave', 'love', 'spin'] },
  { id: 'ember', name: 'Ember', blurb: 'A pocket fire lizard. Its tail flame flares when it gets excited.', cost: { free: true }, voice: 660, taps: ['hop', 'cheer', 'angry', 'wave'] },
  { id: 'bolt', name: 'Bolt', blurb: 'A tiny duel robot. Beeps, boops and screen faces.', cost: { free: true }, voice: 990, taps: ['wave', 'spin', 'wow', 'hop'] },
  { id: 'sprout', name: 'Sprout', blurb: 'A seedling spirit that grows a leaf every time you win.', cost: { chips: 3 }, voice: 1040, taps: ['hop', 'love', 'wave', 'sleep'] },
  { id: 'wisp', name: 'Wisp', blurb: 'A spooky little flame. Mostly harmless. Mostly.', cost: { chips: 4 }, voice: 520, taps: ['spin', 'laugh', 'wow', 'wave'] },
  { id: 'pebble', name: 'Pebble', blurb: 'A mossy rock golem who naps between turns.', cost: { chips: 4 }, voice: 330, taps: ['sleep', 'hop', 'wave', 'cheer'] },
  { id: 'mimic', name: 'Mimic', blurb: 'A treasure chest with teeth. Do not open.', cost: { chips: 6 }, voice: 440, taps: ['laugh', 'angry', 'wow', 'hop'] },
  { id: 'hoot', name: 'Professor Hoot', blurb: 'An owl wizard who has read every card text twice.', cost: { chips: 6 }, voice: 600, taps: ['wave', 'wow', 'spin', 'sleep'] },
  { id: 'chill', name: 'Chill', blurb: 'A penguin too cool to take off its shades.', cost: { chips: 8 }, voice: 740, taps: ['spin', 'laugh', 'wave', 'cheer'] },
  { id: 'scarab', name: 'Scarab', blurb: 'A golden beetle from a forgotten tomb.', cost: { chips: 8 }, voice: 500, taps: ['spin', 'hop', 'wow', 'cheer'] },
  { id: 'sphinx', name: 'Sphinxy', blurb: 'A royal desert cat. Asks riddles, ignores answers.', cost: { chips: 10 }, voice: 820, taps: ['love', 'sleep', 'angry', 'wave'] },
  { id: 'gloop', name: 'Gloop', blurb: 'A jelly slime that wobbles at everything.', cost: { wins: 5 }, voice: 400, taps: ['hop', 'laugh', 'love', 'wow'] },
  { id: 'kitsu', name: 'Kitsu', blurb: 'A two-tailed fox spirit with a trick up each tail.', cost: { wins: 15 }, voice: 940, taps: ['spin', 'laugh', 'love', 'wave'] },
  { id: 'nova', name: 'Nova', blurb: 'A fallen star who wants to be a duelist.', cost: { school: true }, voice: 1180, taps: ['spin', 'cheer', 'love', 'wave'] },
  { id: 'drake', name: 'Little Drake', blurb: 'A baby dragon with a crown it insists it earned.', cost: { wins: 30 }, voice: 300, taps: ['cheer', 'angry', 'spin', 'hop'] },
];

const BY_ID = new Map(MATES.map((m) => [m.id, m]));
export const mateDef = (id: string | null | undefined): MateDef | undefined => (id ? BY_ID.get(id as MateId) : undefined);
export const isMate = (id: unknown): id is MateId => typeof id === 'string' && BY_ID.has(id as MateId);
export const isReact = (r: unknown): r is MateReact => typeof r === 'string' && (REACTS as readonly string[]).includes(r);

export const DEFAULT_MATE: MateId = 'pip';

/** Has this duelist got the mate (free ones and reached milestones count without buying)? */
export function hasMate(s: SpeedSave, id: MateId): boolean {
  const m = BY_ID.get(id);
  if (!m) return false;
  if ('free' in m.cost) return true;
  if ('wins' in m.cost) return s.wins >= m.cost.wins;
  if ('school' in m.cost) return lessonsDone(s).length >= LESSONS.length;
  return !!s.mates?.includes(id);
}

/** The mate this duelist brings to duels (one they no longer have falls back to Pip). */
export function chosenMate(s: SpeedSave | null | undefined): MateId {
  const id = s?.mate;
  return s && isMate(id) && hasMate(s, id) ? id : DEFAULT_MATE;
}

/** What it takes to get a mate, said for its card. */
export function costNote(s: SpeedSave, m: MateDef): string {
  if ('free' in m.cost) return 'Free';
  if ('chips' in m.cost) return `${m.cost.chips} Duel Chips`;
  if ('wins' in m.cost) return `Win ${m.cost.wins} Speed Duels (${Math.min(s.wins, m.cost.wins)}/${m.cost.wins})`;
  return `Finish Duel School (${lessonsDone(s).length}/${LESSONS.length})`;
}

/** Why a mate can't be bought right now (null: it can). */
export function cantBuy(s: SpeedSave, id: MateId): string | null {
  const m = BY_ID.get(id);
  if (!m || !('chips' in m.cost)) return 'This mate is earned, not bought';
  if (hasMate(s, id)) return 'Already yours';
  if (chipsOf(s) < m.cost.chips) return `Needs ${m.cost.chips} Duel Chips (you have ${chipsOf(s)})`;
  return null;
}

/** Buys a mate with Duel Chips (null: can't). */
export function buyMate(s: SpeedSave, id: MateId): SpeedSave | null {
  if (cantBuy(s, id)) return null;
  const m = BY_ID.get(id)!;
  const price = (m.cost as { chips: number }).chips;
  return { ...s, chips: chipsOf(s) - price, mates: [...(s.mates ?? []), id] };
}

/** Takes a mate along to duels (only one this duelist has). */
export function pickMate(s: SpeedSave, id: MateId): SpeedSave | null {
  return hasMate(s, id) ? { ...s, mate: id } : null;
}

/** A computer duelist's mate: the same one every time for the same name. */
export function mateForName(name: string): MateId {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return MATES[h % MATES.length].id;
}

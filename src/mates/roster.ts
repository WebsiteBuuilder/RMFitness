// Mates: little companions that stand beside each player's field in a Speed Duel, like
// Master Duel's Mates. Purely for show: they never touch the duel. Each one is a chibi of a
// monster from the Speed Duel card pool (drawn in MateArt.tsx).
import type { SpeedSave } from '../eds/speedSave';
import { chipsOf } from '../collection/economy';
import { lessonsDone, LESSONS } from '../eds/tutorial';

export type MateId =
  | 'blueeyes'
  | 'kuriboh'
  | 'babydragon'
  | 'wkuriboh'
  | 'mokeymokey'
  | 'ojama'
  | 'sangan'
  | 'penguin'
  | 'timewizard'
  | 'redeyes'
  | 'darkmagician'
  | 'cyberdragon'
  | 'jinzo'
  | 'slifer'
  | 'dmg';

/** How a mate is had: free from the start, bought with Duel Chips, or earned. */
export type MateCost = { free: true } | { chips: number } | { wins: number } | { school: true };

export interface MateDef {
  id: MateId;
  name: string;
  /** the Speed Duel card it comes from */
  card: string;
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
  { id: 'blueeyes', name: 'Blue-Eyes', card: 'Blue-Eyes White Dragon', blurb: 'The legendary dragon, pocket size. Still roars like it owns the field.', cost: { free: true }, voice: 520, taps: ['cheer', 'spin', 'angry', 'wave'] },
  { id: 'kuriboh', name: 'Kuriboh', card: 'Kuriboh', blurb: 'Kuri kuri! Small, fluffy, and always ready to take a hit for you.', cost: { free: true }, voice: 900, taps: ['hop', 'love', 'wave', 'spin'] },
  { id: 'babydragon', name: 'Baby Dragon', card: 'Baby Dragon', blurb: 'Joey’s little dragon. One day it will grow up into something huge.', cost: { free: true }, voice: 720, taps: ['hop', 'cheer', 'wave', 'laugh'] },
  { id: 'wkuriboh', name: 'Winged Kuriboh', card: 'Winged Kuriboh', blurb: 'Kuriboh with angel wings. Floats about and never stops smiling.', cost: { chips: 3 }, voice: 980, taps: ['spin', 'love', 'hop', 'wave'] },
  { id: 'mokeymokey', name: 'Mokey Mokey', card: 'Mokey Mokey', blurb: 'A blank little angel. Do not make it angry.', cost: { chips: 3 }, voice: 640, taps: ['sleep', 'hop', 'angry', 'wave'] },
  { id: 'ojama', name: 'Ojama Yellow', card: 'Ojama Yellow', blurb: 'Loud, cheeky and very, very yellow.', cost: { chips: 4 }, voice: 820, taps: ['laugh', 'spin', 'love', 'wow'] },
  { id: 'sangan', name: 'Sangan', card: 'Sangan', blurb: 'Three eyes, two little claws and one big grin.', cost: { chips: 4 }, voice: 420, taps: ['laugh', 'spin', 'hop', 'angry'] },
  { id: 'penguin', name: 'Penguin Soldier', card: 'Penguin Soldier', blurb: 'A tiny soldier with a big sword. Salutes every Summon.', cost: { chips: 5 }, voice: 760, taps: ['wave', 'cheer', 'hop', 'angry'] },
  { id: 'timewizard', name: 'Time Wizard', card: 'Time Wizard', blurb: 'Spins its clock and hopes for the best. Tick tock!', cost: { chips: 6 }, voice: 880, taps: ['spin', 'laugh', 'wow', 'wave'] },
  { id: 'redeyes', name: 'Red-Eyes', card: 'Red-Eyes Black Dragon', blurb: 'The dragon of potential. Small now, fearsome later.', cost: { chips: 8 }, voice: 380, taps: ['angry', 'cheer', 'spin', 'hop'] },
  { id: 'darkmagician', name: 'Dark Magician', card: 'Dark Magician', blurb: 'The ultimate wizard in terms of attack and defense, in chibi form.', cost: { chips: 10 }, voice: 600, taps: ['spin', 'wave', 'cheer', 'wow'] },
  { id: 'cyberdragon', name: 'Cyber Dragon', card: 'Cyber Dragon', blurb: 'A chrome serpent that whirrs when it is happy.', cost: { wins: 5 }, voice: 990, taps: ['spin', 'wow', 'cheer', 'hop'] },
  { id: 'jinzo', name: 'Jinzo', card: 'Jinzo', blurb: 'No Traps allowed. Not even when it’s just watching.', cost: { wins: 15 }, voice: 300, taps: ['angry', 'laugh', 'wave', 'spin'] },
  { id: 'slifer', name: 'Slifer', card: 'Slifer the Sky Dragon', blurb: 'An Egyptian God, curled up small. Earned, never bought.', cost: { wins: 30 }, voice: 340, taps: ['cheer', 'spin', 'angry', 'wow'] },
  { id: 'dmg', name: 'Dark Magician Girl', card: 'Dark Magician Girl', blurb: 'Your Duel School graduation present. Cheers louder than anyone.', cost: { school: true }, voice: 1100, taps: ['love', 'cheer', 'wave', 'spin'] },
];

const BY_ID = new Map(MATES.map((m) => [m.id, m]));
export const mateDef = (id: string | null | undefined): MateDef | undefined => (id ? BY_ID.get(id as MateId) : undefined);
export const isMate = (id: unknown): id is MateId => typeof id === 'string' && BY_ID.has(id as MateId);
export const isReact = (r: unknown): r is MateReact => typeof r === 'string' && (REACTS as readonly string[]).includes(r);

export const DEFAULT_MATE: MateId = 'blueeyes';

/** Has this duelist got the mate (free ones and reached milestones count without buying)? */
export function hasMate(s: SpeedSave, id: MateId): boolean {
  const m = BY_ID.get(id);
  if (!m) return false;
  if ('free' in m.cost) return true;
  if ('wins' in m.cost) return s.wins >= m.cost.wins;
  if ('school' in m.cost) return lessonsDone(s).length >= LESSONS.length;
  return !!s.mates?.includes(id);
}

/** The mate this duelist brings to duels (one they no longer have falls back to Blue-Eyes). */
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

/** The first Mates (before they came from the cards): their Duel Chip prices, paid back once. */
const RETIRED: Record<string, number> = { sprout: 3, wisp: 4, pebble: 4, mimic: 6, hoot: 6, chill: 8, scarab: 8, sphinx: 10 };
/** ...and the free or earned ones, which may still be the chosen Mate. */
const RETIRED_FREE = ['pip', 'ember', 'bolt', 'gloop', 'kitsu', 'nova', 'drake'];
const retired = (id: unknown) => typeof id === 'string' && (id in RETIRED || RETIRED_FREE.includes(id));

/** Pays back Mates bought before the roster became cards (null: nothing to pay back). Only
 *  those old ids go: a Mate this version doesn't know yet (bought on a newer phone) is kept. */
export function retireOldMates(s: SpeedSave): { save: SpeedSave; chips: number } | null {
  const old = (s.mates ?? []).filter(retired);
  if (!old.length && !retired(s.mate)) return null;
  const chips = old.reduce((n, id) => n + (RETIRED[id] ?? 0), 0);
  const next: SpeedSave = { ...s, mates: (s.mates ?? []).filter((id) => !retired(id)), chips: chipsOf(s) + chips };
  if (retired(next.mate)) delete next.mate;
  return { save: next, chips };
}

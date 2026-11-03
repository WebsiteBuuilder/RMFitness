// Ace bond: each duelist picks one monster as their Ace. Whenever it is Summoned it gets an
// entrance of its own that grows grander with every duel won with it in the deck, and it
// shouts its attack's name (src/art/callouts.ts). Cosmetic only: it pays no cards, chips or
// packs, and only duels that earn things count (never Practice, watching, or an Anything goes deck).
// Pure, apart from the duel registry the 3D stage reads.
import type { Pid } from '../eds/types';
import type { SpeedSave } from '../eds/speedSave';

/** The bond levels: wins needed, and what the entrance adds at each. */
export const BOND_LEVELS = [
  { lv: 1, wins: 0, title: 'Partner', adds: 'Its own cut-in and a crest of light' },
  { lv: 2, wins: 3, title: 'Trusted Ace', adds: 'Pillars of light and rising embers' },
  { lv: 3, wins: 10, title: 'Battle-Bonded', adds: 'Time stops as it arrives, shockwaves roll out' },
  { lv: 4, wins: 25, title: 'Soulbound', adds: 'A crown of stars orbits it, the field shakes' },
  { lv: 5, wins: 50, title: 'Legendary Ace', adds: 'A sky-splitting aurora and a golden title' },
] as const;
export const MAX_BOND = BOND_LEVELS.length;

/** The bond level (1..5) for a number of wins. */
export function bondLevel(wins: number): number {
  let lv = 1;
  for (const b of BOND_LEVELS) if (wins >= b.wins) lv = b.lv;
  return lv;
}
export const bondTitle = (lv: number) => BOND_LEVELS[Math.max(0, Math.min(MAX_BOND, lv) - 1)].title;

/** Wins still needed for the next level (null at the top). */
export function nextBond(wins: number): { lv: number; need: number; at: number } | null {
  const lv = bondLevel(wins);
  const nx = BOND_LEVELS[lv];
  return nx ? { lv: nx.lv, need: nx.wins - wins, at: nx.wins } : null;
}

export interface AceInfo {
  name: string;
  /** bond level 1..5 */
  lv: number;
  wins: number;
}

type AceSave = SpeedSave;

/** The duelist's Ace, or null when none is picked (or they no longer own it). */
export function aceOf(s: SpeedSave | null | undefined): AceInfo | null {
  const a = s as AceSave | null | undefined;
  const name = a?.ace;
  if (!a || !name || !((a.collection?.[name] ?? 0) > 0)) return null;
  const wins = Math.max(0, Math.floor(a.aceWins?.[name] ?? 0));
  return { name, lv: bondLevel(wins), wins };
}

/** Wins with a card as the Ace (kept per card: switching Aces never loses a bond). */
export const aceWinsFor = (s: SpeedSave, name: string): number => Math.max(0, Math.floor((s as AceSave).aceWins?.[name] ?? 0));

/** A copy of the save with this card as the Ace (null: no Ace). */
export function withAce(s: SpeedSave, name: string | null): SpeedSave {
  const next = { ...(s as AceSave) };
  if (name) next.ace = name;
  else delete next.ace;
  return next;
}

/** Can this card be an Ace: a monster this duelist owns. */
export function canBeAce(s: SpeedSave, name: string, isMonster: (n: string) => boolean): boolean {
  return (s.collection?.[name] ?? 0) > 0 && isMonster(name);
}

export interface AceWinCtx {
  /** the duel was won */
  won: boolean;
  /** the duel earns things (not Practice, not watching, not an Anything goes deck, not over too quickly) */
  counts: boolean;
  /** every card of the deck played (main and Extra) */
  deck: string[];
}

/**
 * One duel's result for the Ace: a counted win with the Ace in the deck adds one win to its
 * bond. Returns the new save and, when the bond went up a level, a line for the result screen.
 */
export function withAceWin(s: SpeedSave, ctx: AceWinCtx): { save: SpeedSave; line: string | null } {
  const ace = aceOf(s);
  if (!ace || !ctx.won || !ctx.counts || !ctx.deck.includes(ace.name)) return { save: s, line: null };
  const a = s as AceSave;
  const wins = ace.wins + 1;
  const save = { ...a, aceWins: { ...(a.aceWins ?? {}), [ace.name]: wins } } as SpeedSave;
  const lv = bondLevel(wins);
  const line = lv > ace.lv ? `★ Ace bond up! ${ace.name} is now ${bondTitle(lv)} (bond ${lv}): its entrance grows grander.` : null;
  return { save, line };
}

// ---------- the duel on screen ----------
let duelAces: [AceInfo | null, AceInfo | null] = [null, null];

/** The duel screen calls this with each seat's Ace (null to stop). */
export function showDuelAces(aces: [AceInfo | null | undefined, AceInfo | null | undefined] | null) {
  duelAces = aces ? [aces[0] ?? null, aces[1] ?? null] : [null, null];
}

/** The Ace a summoned card is, for its owner: null when it is not their Ace. */
export function aceFor(owner: Pid | undefined, name: string): AceInfo | null {
  if (owner !== 0 && owner !== 1 || !name) return null;
  const a = duelAces[owner];
  return a && a.name === name ? a : null;
}

/** An Ace as it may ride a room's JOIN (from the other phone): a card name and a level, checked. */
export function aceFromWire(v: unknown): AceInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as { name?: unknown; lv?: unknown };
  if (typeof o.name !== 'string' || o.name.length > 80 || !o.name.trim()) return null;
  const lv = typeof o.lv === 'number' && Number.isFinite(o.lv) ? Math.max(1, Math.min(MAX_BOND, Math.floor(o.lv))) : 1;
  return { name: o.name, lv, wins: BOND_LEVELS[lv - 1].wins };
}
/** ...and what this phone sends. */
export const aceToWire = (a: AceInfo | null): { name: string; lv: number } | undefined => (a ? { name: a.name, lv: a.lv } : undefined);

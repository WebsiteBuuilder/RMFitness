// Duelist Rankings: link-battle records (Speed Duel and Eternal Duelist Soul) for every duelist
// this phone knows: its own profiles and the friends who shared theirs. A record and a title,
// never a prize: nothing here pays chips, packs or cards, so there is nothing to farm.
import type { SpeedSave } from '../eds/speedSave';
import type { SaveFile } from '../eds/save';
import { rivalsOf, type Rival } from './economy';

export interface Rec {
  w: number;
  l: number;
  d: number;
}

/** What a duelist shows on the board (also what friends send each other). */
export interface BoardStats extends Rec {
  /** best current run of wins against any one rival */
  streak: number;
  /** duelists this one sent to the Shadow Realm */
  shadow?: number;
  /** Ranked Duel: the season ("2026-10"), the ladder step and Duel King points */
  rk?: { s: string; step: number; kp: number; st?: number };
}

export interface BoardEntry extends BoardStats {
  name: string;
  kind: 'me' | 'phone' | 'friend';
  color?: string;
  online?: boolean;
}

export interface BoardRow extends BoardEntry {
  place: number;
  points: number;
  title: Title;
}

export interface Title {
  name: string;
  icon: string;
  /** rank points needed */
  at: number;
}

/** The title ladder, from the show: everyone starts a Rookie, the top is King of Games. */
export const TITLES: Title[] = [
  { name: 'Rookie Duelist', icon: '🃏', at: 0 },
  { name: 'Duelist', icon: '⚔️', at: 10 },
  { name: 'Expert Duelist', icon: '🎴', at: 60 },
  { name: 'Duel Champion', icon: '🏆', at: 150 },
  { name: 'Duel Master', icon: '🐉', at: 300 },
  { name: 'Legendary Duelist', icon: '🔥', at: 500 },
  { name: 'King of Games', icon: '👑', at: 800 },
];

/** Rank points: 10 a win, 3 a draw, minus 5 a loss, never below 0. */
export const rankOf = (r: Rec) => Math.max(0, 10 * r.w + 3 * r.d - 5 * r.l);

export function duelistTitle(r: Rec): Title & { next: Title | null } {
  const p = rankOf(r);
  let i = 0;
  while (i + 1 < TITLES.length && p >= TITLES[i + 1].at) i++;
  return { ...TITLES[i], next: TITLES[i + 1] ?? null };
}

/** Ranks the board: rank points, then the hotter streak, then more wins. */
export function boardRows(rows: BoardEntry[]): BoardRow[] {
  const out = rows.map((r) => ({ ...r, points: rankOf(r), title: duelistTitle(r) as Title }));
  out.sort((a, b) => b.points - a.points || b.streak - a.streak || b.w - a.w || a.name.localeCompare(b.name));
  return out.map((r, i) => ({ ...r, place: i + 1 }));
}

/** A profile's link-battle record across both games: Speed Duel rivals plus EDS "Link:" rows. */
export function linkStats(speed: SpeedSave | null, eds: SaveFile | null, shadow = 0): BoardStats {
  const out: BoardStats = { w: 0, l: 0, d: 0, streak: 0, shadow };
  if (speed)
    for (const r of Object.values(rivalsOf(speed)) as Rival[]) {
      out.w += r.w;
      out.l += r.l;
      out.d += r.d;
      out.streak = Math.max(out.streak, r.streak);
    }
  if (eds)
    for (const [k, r] of Object.entries(eds.record ?? {}))
      if (k.startsWith('Link: ')) {
        out.w += r.w;
        out.l += r.l;
        out.d += r.d;
      }
  return out;
}

/** Head-to-head rows for one profile: every rival, most duels first. */
export function rivalRows(speed: SpeedSave | null, eds: SaveFile | null): { name: string; w: number; l: number; d: number; streak: number }[] {
  const m = new Map<string, { name: string; w: number; l: number; d: number; streak: number }>();
  const add = (name: string, r: Rec, streak = 0) => {
    const o = m.get(name) ?? { name, w: 0, l: 0, d: 0, streak: 0 };
    m.set(name, { name, w: o.w + r.w, l: o.l + r.l, d: o.d + r.d, streak: streak || o.streak });
  };
  if (speed) for (const [n, r] of Object.entries(rivalsOf(speed))) add(n, r, r.streak);
  if (eds) for (const [k, r] of Object.entries(eds.record ?? {})) if (k.startsWith('Link: ')) add(k.slice(6), r);
  return [...m.values()].sort((a, b) => b.w + b.l + b.d - (a.w + a.l + a.d) || a.name.localeCompare(b.name));
}

/** Keeps a shared record sane (it comes from another phone). */
export function cleanStats(x: unknown): BoardStats | null {
  const o = x as Partial<BoardStats> | null;
  if (!o || typeof o !== 'object') return null;
  const n = (v: unknown, max = 1e6) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-max, Math.min(max, Math.floor(v))) : 0);
  const rk = o.rk && typeof o.rk === 'object' && typeof o.rk.s === 'string' && /^\d{4}-\d{2}$/.test(o.rk.s) ? { s: o.rk.s, step: Math.max(0, n(o.rk.step, 30)), kp: Math.max(0, n(o.rk.kp, 100000)), st: Math.max(0, n(o.rk.st, 9)) } : undefined;
  return { w: Math.max(0, n(o.w)), l: Math.max(0, n(o.l)), d: Math.max(0, n(o.d)), streak: n(o.streak, 1000), shadow: Math.max(0, n(o.shadow)), ...(rk ? { rk } : {}) };
}

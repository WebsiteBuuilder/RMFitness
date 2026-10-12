// Card leveling (Speed Duel only): every card in a profile's collection has a
// rarity meter that fills as the card is played. Playing it fills a little;
// winning fights fills a lot (destroying a monster, battle damage, a direct
// attack, effect damage, the finishing blow). Dying on the field or being
// banished drains a little, but never below the rarity the card already reached.
// The meter climbs through Master Duel's rarities: N, R, SR, UR, then the
// Glossy and Royal finishes, and tops out at Overframe, where the card's art
// breaks out of its frame. It is a look only: ATK, DEF and effects never change.
//
// The engine calls noteLevelEvent for every event of a Speed Duel, so the tally
// lives in the duel state (state.fx.lvl) and both phones in a Link Battle count
// the same. At the end of the duel each profile applies its own seat's tally.
import { card } from '../eds/db';
import type { Card, DuelState, EngineEvent, Pid } from '../eds/types';
import type { SpeedSave } from '../eds/speedSave';

// ---------- rarities ----------
export interface Tier {
  id: 'N' | 'R' | 'SR' | 'UR' | 'GL' | 'RO' | 'OF';
  short: string;
  name: string;
  /** meter points needed to reach it */
  at: number;
}

export const TIERS: Tier[] = [
  { id: 'N', short: 'N', name: 'Normal', at: 0 },
  { id: 'R', short: 'R', name: 'Rare', at: 60 },
  { id: 'SR', short: 'SR', name: 'Super Rare', at: 200 },
  { id: 'UR', short: 'UR', name: 'Ultra Rare', at: 500 },
  { id: 'GL', short: 'UR', name: 'Glossy Ultra Rare', at: 1100 },
  { id: 'RO', short: 'UR', name: 'Royal Ultra Rare', at: 2200 },
  { id: 'OF', short: 'OVER', name: 'Overframe', at: 4000 },
];

export function tierIndex(xp: number): number {
  let i = 0;
  while (i + 1 < TIERS.length && xp >= TIERS[i + 1].at) i++;
  return i;
}

export const tierOf = (xp: number): Tier => TIERS[tierIndex(xp)];

/** How full the meter is toward the next rarity, 0..1 (1 at the top rarity). */
export function meterOf(xp: number): number {
  const i = tierIndex(xp);
  if (i === TIERS.length - 1) return 1;
  return (xp - TIERS[i].at) / (TIERS[i + 1].at - TIERS[i].at);
}

// ---------- how much each thing is worth ----------
export const XP = {
  /** the card was in the deck for a finished duel */
  inDeck: 2,
  /** summoned, set or activated (counted up to PLAY_CAP times a duel) */
  play: 6,
  /** a played card on the winning side */
  win: 4,
  /** destroyed or banished a monster, in battle or with its effect */
  kill: 30,
  /** dealt battle damage (plus 1 per 100 damage) */
  battle: 20,
  /** dealt damage with a direct attack (plus 1 per 100 damage) */
  direct: 30,
  /** dealt damage with its effect (plus 1 per 200 damage) */
  effect: 15,
  /** dealt the hit that won the duel */
  finish: 25,
  /** destroyed on the field (drain) */
  died: -3,
  /** banished (drain) */
  banished: -5,
};
export const PLAY_CAP = 5;

// ---------- the tally kept during a duel ----------
/** One card name's deeds in one duel, for one player. */
export interface Deeds {
  /** plays */
  p: number;
  /** kills */
  k: number;
  /** battle damage hits, and total */
  b: number;
  bd: number;
  /** direct attack hits, and total */
  d: number;
  dd: number;
  /** effect damage hits, and total */
  e: number;
  ed: number;
  /** finishing blows */
  f: number;
  /** died on the field */
  x: number;
  /** banished */
  r: number;
}

interface Tally {
  s: [Record<string, Deeds>, Record<string, Deeds>];
  /** uids of monsters face-up or set on the field */
  on: number[];
}

/** What the engine knows that the duel state does not. */
export interface LevelCtx {
  /** the card whose effect is resolving (null for game actions) */
  source: number | null;
  /** a chain link is resolving */
  inChain: boolean;
  find(uid: number): { card: Card; loc: { player: Pid; zone: string } } | null;
}

const blank = (): Deeds => ({ p: 0, k: 0, b: 0, bd: 0, d: 0, dd: 0, e: 0, ed: 0, f: 0, x: 0, r: 0 });
const isToken = (c: Card) => !!c.token || c.name.startsWith('__token') || !c.name;

function tally(state: DuelState): Tally {
  return (state.fx.lvl ??= { s: [{}, {}], on: [] }) as Tally;
}

function deeds(t: Tally, c: Card): Deeds {
  return (t.s[c.owner][c.name] ??= blank());
}

function isMonster(name: string) {
  return card(name)?.kind === 'monster';
}

/** Counts one engine event toward the cards involved. Speed Duels only. */
export function noteLevelEvent(state: DuelState, ev: EngineEvent, ctx: LevelCtx) {
  if (state.rules?.mode !== 'speed' || (ev.uid === undefined && ev.kind !== 'damage')) return;
  const t = tally(state);
  const lookup = (uid: number | null | undefined) => (uid === null || uid === undefined ? null : ctx.find(uid)?.card ?? null);
  switch (ev.kind) {
    case 'summon':
    case 'set':
    case 'activate': {
      const c = lookup(ev.uid);
      if (!c || isToken(c)) {
        if (c && ev.kind !== 'activate' && !t.on.includes(c.uid)) t.on.push(c.uid);
        return;
      }
      deeds(t, c).p++;
      if (ev.kind !== 'activate' && ctx.find(c.uid)?.loc.zone === 'mz' && !t.on.includes(c.uid)) t.on.push(c.uid);
      return;
    }
    case 'flip': {
      if (ev.uid !== undefined && ctx.find(ev.uid)?.loc.zone === 'mz' && !t.on.includes(ev.uid)) t.on.push(ev.uid);
      return;
    }
    case 'to-hand': {
      t.on = t.on.filter((u) => u !== ev.uid);
      return;
    }
    case 'to-gy': {
      const uid = ev.uid!;
      const wasOn = t.on.includes(uid);
      t.on = t.on.filter((u) => u !== uid);
      const f = ctx.find(uid);
      if (!f || isToken(f.card)) return;
      const victim = f.card;
      const banished = f.loc.zone === 'removed';
      if (banished) deeds(t, victim).r++;
      else if (wasOn && isMonster(victim.name)) deeds(t, victim).x++;
      if (!wasOn) return;
      // Who took it out: the other monster in this battle, or the card whose effect is resolving.
      let killer: Card | null = null;
      const battle = state.battle;
      if (battle && !ctx.inChain) killer = lookup(battle.attacker === uid ? battle.target : battle.attacker);
      else if (ctx.source !== null) killer = lookup(ctx.source);
      if (killer && killer.uid !== uid && killer.owner !== victim.owner && !isToken(killer)) deeds(t, killer).k++;
      return;
    }
    case 'damage': {
      // Paying LP has no `from`; only real damage counts.
      if (ev.from === undefined || ev.player === undefined || !ev.amount) return;
      const hurt = ev.player;
      let dealer: Card | null = null;
      let how: 'b' | 'd' | 'e' = 'e';
      const battle = state.battle;
      if (battle && !ctx.inChain) {
        const a = lookup(battle.attacker);
        if (a && a.owner !== hurt) {
          dealer = a;
          how = battle.target === null ? 'd' : 'b';
        } else {
          dealer = lookup(battle.target);
          how = 'b';
        }
      } else if (ctx.source !== null) dealer = lookup(ctx.source);
      if (!dealer || isToken(dealer) || dealer.owner === hurt) return;
      const d = deeds(t, dealer);
      const dealt = Math.min(ev.amount, ev.from);
      d[how]++;
      if (how === 'b') d.bd += dealt;
      else if (how === 'd') d.dd += dealt;
      else d.ed += dealt;
      if (state.players[hurt].lp <= 0) d.f++;
      return;
    }
  }
}

// ---------- the end of a duel ----------
export interface LevelRow {
  name: string;
  before: number;
  after: number;
  /** points this duel added and drained (before the rarity floor) */
  gained: number;
  lost: number;
  /** a short line on what it did */
  why: string;
}

export interface LevelReport {
  at: number;
  rows: LevelRow[];
}

/** Every card name the player brought to this duel, wherever it ended up. */
function namesOwnedBy(state: DuelState, p: Pid): string[] {
  const out = new Set<string>();
  for (const ps of state.players) {
    for (const list of [ps.deck, ps.hand, ps.gy, ps.removed, ps.fusion]) for (const c of list) if (c.owner === p && !isToken(c)) out.add(c.name);
    for (const c of [...ps.mz, ...ps.sz, ps.field]) if (c && c.owner === p && !isToken(c)) out.add(c.name);
  }
  return [...out];
}

/** Points one card earned and lost in a duel. */
export function scoreDeeds(d: Deeds | undefined, won: boolean): { gained: number; lost: number; why: string } {
  let gained = XP.inDeck;
  let lost = 0;
  const why: string[] = [];
  if (!d) return { gained, lost, why: 'in your deck' };
  const plays = Math.min(d.p, PLAY_CAP);
  gained += plays * XP.play;
  if (d.p > 0 && won) gained += XP.win;
  gained += d.k * XP.kill;
  gained += d.b * XP.battle + Math.floor(d.bd / 100);
  gained += d.d * XP.direct + Math.floor(d.dd / 100);
  gained += d.e * XP.effect + Math.floor(d.ed / 200);
  gained += d.f * XP.finish;
  lost += d.x * -XP.died + d.r * -XP.banished;
  if (d.f) why.push('finishing blow');
  if (d.k) why.push(`${d.k} destroyed`);
  if (d.d) why.push(`${d.dd} direct damage`);
  if (d.b) why.push(`${d.bd} battle damage`);
  if (d.e) why.push(`${d.ed} effect damage`);
  if (d.p) why.push(`played ${d.p}×`);
  if (d.x) why.push(`died ${d.x}×`);
  if (d.r) why.push(`banished ${d.r}×`);
  return { gained, lost, why: why.join(' · ') || 'in your deck' };
}

type LevelSave = SpeedSave & { levels?: Record<string, number>; lastLevels?: LevelReport };

export function cardLevels(s: SpeedSave): Record<string, number> {
  return (s as LevelSave).levels ?? {};
}

export function lastLevelReport(s: SpeedSave): LevelReport | null {
  return (s as LevelSave).lastLevels ?? null;
}

export function xpOf(s: SpeedSave, name: string): number {
  return cardLevels(s)[name] ?? 0;
}

/** Adds points to a meter; drains stop at the start of the rarity the card already has. */
export function addXp(xp: number, gained: number, lost: number): number {
  const up = xp + gained;
  const floor = TIERS[tierIndex(up)].at;
  return Math.max(floor, up - lost);
}

/** Writes one duel's card levels for the player in `seat` into their save. */
export function withLevels(s: SpeedSave, state: DuelState, seat: Pid, now = Date.now()): { save: SpeedSave; report: LevelReport } {
  const levels = { ...cardLevels(s) };
  const t = state.fx?.lvl as Tally | undefined;
  const won = state.winner === seat;
  const rows: LevelRow[] = [];
  if (state.rules?.mode === 'speed') {
    for (const name of namesOwnedBy(state, seat)) {
      const { gained, lost, why } = scoreDeeds(t?.s[seat][name], won);
      const before = levels[name] ?? 0;
      const after = addXp(before, gained, lost);
      levels[name] = after;
      rows.push({ name, before, after, gained, lost, why });
    }
  }
  rows.sort((a, b) => b.after - b.before - (a.after - a.before) || a.name.localeCompare(b.name));
  const report = { at: now, rows };
  return { save: { ...s, levels, lastLevels: report } as LevelSave, report };
}

/** Each card's rarity tier for a deck, to show the opponent in a Link Battle. */
export function rarityMap(s: SpeedSave, names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const lv = cardLevels(s);
  for (const n of names) {
    const i = tierIndex(lv[n] ?? 0);
    if (i > 0) out[n] = i;
  }
  return out;
}

// The Shadow Realm: when a Speed Duel's final hit does at least OVERKILL_MARGIN
// more damage than the loser had left, the loser is sent to the Shadow Realm.
// The stake: the loser's strongest monster from the deck they used is sealed
// there. A sealed card is left out of every deck that profile duels with until
// they win a duel, which frees the card sealed longest. At most 3 cards are
// sealed at once (a 4th frees the oldest). Computer duelists play by the same
// rule against each profile. Everything here is worked out from the duel state,
// so both phones in a Link Battle agree on who was sent and what was sealed.
import { card } from '../eds/db';
import { other } from '../eds/engine';
import type { Card, DuelState, Pid } from '../eds/types';
import type { SpeedDeck, SpeedSave } from '../eds/speedSave';

export const OVERKILL_MARGIN = 1000;
export const MAX_SEALED = 3;

export interface ShadowResult {
  loser: Pid;
  winner: Pid;
  loserName: string;
  winnerName: string;
  /** damage past 0 */
  excess: number;
  /** the card sealed in the Shadow Realm (null when the loser had no monsters) */
  sealed: string | null;
}

export interface SealedCard {
  name: string;
  /** who sent them there */
  by: string;
  at: number;
}

export interface ShadowEntry {
  at: number;
  loser: string;
  winner: string;
  card: string | null;
  excess: number;
}

/** Every card the player brought to this duel, wherever it is now. */
function cardsOwnedBy(state: DuelState, p: Pid): Card[] {
  const out: Card[] = [];
  for (const ps of state.players) {
    for (const list of [ps.deck, ps.hand, ps.gy, ps.removed]) for (const c of list) if (c.owner === p) out.push(c);
    for (const c of [...ps.mz, ...ps.sz, ps.field]) if (c && c.owner === p) out.push(c);
  }
  return out.filter((c) => !c.token && !c.name.startsWith('__token'));
}

/** The loser's strongest Main Deck monster: highest ATK, then Level, then name. */
export function sealPick(state: DuelState, loser: Pid): string | null {
  let best: { name: string; atk: number; lv: number } | null = null;
  for (const c of cardsOwnedBy(state, loser)) {
    const info = card(c.name);
    if (!info || info.kind !== 'monster' || info.sub === 'Fusion') continue;
    const atk = info.atk ?? 0;
    const lv = info.level ?? 0;
    if (!best || atk > best.atk || (atk === best.atk && (lv > best.lv || (lv === best.lv && c.name < best.name)))) best = { name: c.name, atk, lv };
  }
  return best?.name ?? null;
}

/** Who was sent to the Shadow Realm in this duel, or null (not a Speed Duel, no overkill...). */
export function shadowRealmOf(state: DuelState): ShadowResult | null {
  if (state.rules?.mode !== 'speed') return null;
  const w = state.winner;
  if (w === null || w === 'draw') return null;
  const fb = state.fx?.finalBlow as { player: Pid; amount: number; from: number } | undefined;
  const loser = other(w);
  if (!fb || fb.player !== loser) return null;
  const excess = fb.amount - fb.from;
  if (excess < OVERKILL_MARGIN) return null;
  return { loser, winner: w, loserName: state.players[loser].name, winnerName: state.players[w].name, excess, sealed: sealPick(state, loser) };
}

// ---------- the stake, kept in each profile's Speed Duel save ----------
type ShadowSave = SpeedSave & { sealed?: SealedCard[]; cpuSealed?: Record<string, SealedCard[]> };

export function sealedCards(s: SpeedSave): SealedCard[] {
  return (s as ShadowSave).sealed ?? [];
}

/** Computer duelists are keyed without accents (the record writes "Tea Gardner"). */
const cpuKey = (name: string) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function cpuSealedCards(s: SpeedSave, cpu: string): SealedCard[] {
  return (s as ShadowSave).cpuSealed?.[cpuKey(cpu)] ?? [];
}

const without = (main: string[], sealed: SealedCard[]) => {
  const names = new Set(sealed.map((x) => x.name));
  return main.filter((n) => !names.has(n));
};

/** A deck with this profile's sealed cards taken out, ready to duel with. */
export function unsealedDeck<T extends Pick<SpeedDeck, 'main'>>(s: SpeedSave, d: T): T {
  return { ...d, main: without(d.main, sealedCards(s)) };
}

/** A computer duelist's deck with the cards this profile has sealed from them taken out. */
export function unsealedCpuMain(s: SpeedSave, cpu: string, main: string[]): string[] {
  return without(main, cpuSealedCards(s, cpu));
}

export interface ShadowChange {
  save: SpeedSave;
  /** a card this profile just got back */
  freed: string | null;
  /** a card this profile just lost */
  lost: string | null;
}

/**
 * Writes one duel's Shadow Realm outcome into a profile's save.
 * `result` is this profile's result; `sr` is the duel's Shadow Realm result (may be null);
 * `mySeat` is this profile's seat; `cpu` names the computer opponent, if any.
 */
export function withShadow(s: SpeedSave, result: 'w' | 'l' | 'd', sr: ShadowResult | null, mySeat: Pid, opp: string, cpu: boolean, now = Date.now()): ShadowChange {
  const next = { ...s } as ShadowSave;
  let sealed = [...(next.sealed ?? [])];
  const cpuMap = { ...(next.cpuSealed ?? {}) };
  let freed: string | null = null;
  let lost: string | null = null;
  if (result === 'w' && sealed.length) freed = sealed.shift()!.name;
  if (sr && sr.loser === mySeat && sr.sealed) {
    lost = sr.sealed;
    sealed = sealed.filter((x) => x.name !== lost);
    sealed.push({ name: lost, by: opp, at: now });
    while (sealed.length > MAX_SEALED) sealed.shift();
  }
  if (cpu) {
    const key = cpuKey(opp);
    let theirs = [...(cpuMap[key] ?? [])];
    if (result === 'l' && theirs.length) theirs.shift();
    if (sr && sr.loser !== mySeat && sr.sealed) {
      theirs = theirs.filter((x) => x.name !== sr.sealed);
      theirs.push({ name: sr.sealed, by: 'you', at: now });
      while (theirs.length > MAX_SEALED) theirs.shift();
    }
    cpuMap[key] = theirs;
  }
  next.sealed = sealed;
  next.cpuSealed = cpuMap;
  return { save: next, freed, lost };
}

// ---------- the Shadow Realm log (this phone) ----------
const LOG_KEY = 'eds.shadowRealm';

export function shadowLog(): ShadowEntry[] {
  try {
    const raw = localStorage.getItem(LOG_KEY);
    const list = raw ? (JSON.parse(raw) as ShadowEntry[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function recordShadow(sr: ShadowResult, now = Date.now()) {
  const list = [{ at: now, loser: sr.loserName, winner: sr.winnerName, card: sr.sealed, excess: sr.excess }, ...shadowLog()].slice(0, 50);
  try {
    localStorage.setItem(LOG_KEY, JSON.stringify(list));
  } catch {
    /* storage blocked */
  }
}

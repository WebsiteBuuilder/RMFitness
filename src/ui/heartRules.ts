// The rules of the Heart of the Cards draw (./heartDraw), kept pure for the tests.
import type { DuelState, Pid } from '../eds/types';

/** How far behind you must be for a destiny draw: 2000 LP behind, or 1000 LP or less while behind. */
export const DESTINY_GAP = 2000;
export const DESTINY_LOW = 1000;

/** Your draw is a destiny draw: you are behind on Life Points by a lot, or low and behind. */
export function isDestiny(state: DuelState, p: Pid): boolean {
  const me = state.players[p].lp;
  const opp = state.players[p === 0 ? 1 : 0].lp;
  return me < opp && (opp - me >= DESTINY_GAP || me <= DESTINY_LOW);
}

/** The newest event's number. */
export const topSeq = (s: DuelState) => (s.events ?? []).reduce((m, x) => Math.max(m, x.seq), 0);

/** `p`'s Draw Phase draw after event `after`, on their own turn, still in their hand (null if none). */
export function freshDraw(state: DuelState, p: Pid, after: number): { uid: number; seq: number } | null {
  // (turn 1 has no Draw Phase draw: the opening hands come in as normal draws, and the deal shows them)
  if (state.winner !== null || state.turnPlayer !== p || state.turn <= 1) return null;
  const evs = state.events ?? [];
  for (let i = evs.length - 1; i >= 0; i--) {
    const x = evs[i];
    if (x.seq <= after) break;
    if (x.kind === 'draw' && !x.effect && x.player === p && x.uid !== undefined && state.players[p].hand.some((c) => c.uid === x.uid)) return { uid: x.uid, seq: x.seq };
  }
  return null;
}


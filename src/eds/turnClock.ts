// Master Duel-style turn timer for online duels between two phones.
// Each phone keeps the clock itself from the duel state it sees: the turn player has TURN_MS for
// their whole turn, the other player RESPOND_MS for each question put to them, and both dip into
// their own BANK_MS for the duel once that runs out. At zero the phone that owes the move plays it.
import type { DuelState, Pid } from './types';

export const TURN_MS = 120_000;
export const RESPOND_MS = 30_000;
export const BANK_MS = 120_000;
/** Below this the clock shows red and ticks. */
export const URGENT_MS = 10_000;

export interface Clock {
  /** what the running allowance belongs to: a turn, or one question to the other player */
  key: string;
  /** time used of that allowance */
  used: number;
  /** each player's reserve left */
  bank: [number, number];
  /** the room's move count when the time ran out and a move was played for them (-1: not yet) */
  spent: number;
}

export interface ClockShow {
  /** whose clock runs */
  who: Pid;
  /** ms left: the allowance plus the bank */
  left: number;
  /** the allowance is gone: this is the bank running */
  bank: boolean;
}

export const newClock = (): Clock => ({ key: '', used: 0, bank: [BANK_MS, BANK_MS], spent: -1 });

/** Who owes the next move: the player asked a question, else the turn player (null: nobody, the duel is over or not on). */
export function actor(s: DuelState): Pid | null {
  if (!s.started || s.winner !== null) return null;
  return s.prompt ? s.prompt.player : s.turnPlayer;
}

/** The allowance running now: the turn player's whole turn, or one question to the other player (by `moves`, the room's move count). */
export function clockKey(s: DuelState, moves: number): string {
  const who = actor(s);
  if (who === null) return '';
  return who === s.turnPlayer ? `t${s.turn}:${who}` : `r${s.turn}:${who}:${moves}`;
}

const allowance = (key: string) => (key.startsWith('t') ? TURN_MS : RESPOND_MS);

/**
 * Runs the clock `dt` ms on the state as it stands. A new key starts its own allowance; a turn
 * player's allowance picks up where it left off after the other player answered something.
 */
export function tick(c: Clock, s: DuelState, moves: number, dt: number, turnUsed: Map<string, number>): Clock {
  const key = clockKey(s, moves);
  const who = actor(s);
  if (!key || who === null) return c;
  let next = c;
  if (key !== c.key) {
    if (c.key.startsWith('t')) turnUsed.set(c.key, c.used);
    next = { ...c, key, used: turnUsed.get(key) ?? 0 };
  }
  if (dt <= 0) return next;
  const room = Math.max(0, allowance(key) - next.used);
  const fromAllowance = Math.min(room, dt);
  const fromBank = Math.min(next.bank[who], dt - fromAllowance);
  const bank: [number, number] = [...next.bank];
  bank[who] -= fromBank;
  return { ...next, used: next.used + fromAllowance, bank };
}

/** What the clock shows for the move owed now. */
export function show(c: Clock, s: DuelState): ClockShow | null {
  const who = actor(s);
  if (who === null || !c.key) return null;
  const room = Math.max(0, allowance(c.key) - c.used);
  return { who, left: room + c.bank[who], bank: room === 0 };
}

/** The time is up for the move owed now, and no move was played for them yet at this point of the duel. */
export const expired = (c: Clock, s: DuelState, moves: number): boolean => {
  const v = show(c, s);
  return !!v && v.left <= 0 && c.spent !== moves;
};

/** "1:05", "0:09" */
export function clockText(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

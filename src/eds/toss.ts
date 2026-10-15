// Who goes first, decided in the open on every phone (official Speed Duel rule: rock-paper-scissors,
// the winner chooses to go first or second). On one phone it's a coin toss; in a rematch the
// loser of the last duel makes the call. Every step is an action in the duel's shared log,
// so both phones see the same hands, the same coin and the same choice.
import type { Pid } from './types';

export type Hand = 'rock' | 'paper' | 'scissors';
export type CoinSide = 'heads' | 'tails';
/** rps: both players throw; coin: one phone, Player 1 calls it; loser: a rematch, the last duel's loser picks */
export type TossHow = 'rps' | 'coin' | 'loser';

export const HANDS: Hand[] = ['rock', 'paper', 'scissors'];

export type TossAction =
  /** the host opens the toss (the Start Duel button, or a rematch getting going) */
  | { type: 'TOSS'; how: TossHow; chooser?: Pid }
  | { type: 'RPS'; player: Pid; hand: Hand; round: number }
  | { type: 'COIN'; player: Pid; call: CoinSide; result: CoinSide }
  /** the toss winner picks who goes first */
  | { type: 'FIRST'; player: Pid; first: Pid };

export interface Toss {
  how: TossHow;
  /** rock-paper-scissors: the round being thrown (a draw throws again) */
  round: number;
  /** this round's hands so far */
  hands: [Hand | null, Hand | null];
  /** every round thrown, oldest first (the last one is shown on screen) */
  rounds: { hands: [Hand, Hand]; winner: Pid | null }[];
  coin: { by: Pid; call: CoinSide; result: CoinSide } | null;
  /** who won the toss and picks */
  chooser: Pid | null;
  /** who goes first, once picked */
  first: Pid | null;
}

const BEATS: Record<Hand, Hand> = { rock: 'scissors', paper: 'rock', scissors: 'paper' };

/** Who wins a throw, or null for a draw. */
export function rpsWinner(a: Hand, b: Hand): Pid | null {
  if (a === b) return null;
  return BEATS[a] === b ? 0 : 1;
}

export function newToss(how: TossHow, chooser?: Pid): Toss {
  return { how, round: 0, hands: [null, null], rounds: [], coin: null, chooser: how === 'loser' ? (chooser ?? 0) : null, first: null };
}

/** The toss after one action from the log (unchanged when the action doesn't fit). */
export function applyToss(t: Toss | null, a: TossAction): Toss | null {
  if (a.type === 'TOSS') return t && t.first === null ? t : newToss(a.how, a.chooser);
  if (!t || t.first !== null) return t;
  if (a.type === 'RPS') {
    if (t.how !== 'rps' || t.chooser !== null || a.round !== t.round || t.hands[a.player] || !HANDS.includes(a.hand)) return t;
    const hands: [Hand | null, Hand | null] = [...t.hands] as [Hand | null, Hand | null];
    hands[a.player] = a.hand;
    if (!hands[0] || !hands[1]) return { ...t, hands };
    const winner = rpsWinner(hands[0], hands[1]);
    const rounds = [...t.rounds, { hands: [hands[0], hands[1]] as [Hand, Hand], winner }];
    return winner === null ? { ...t, round: t.round + 1, hands: [null, null], rounds } : { ...t, hands, rounds, chooser: winner };
  }
  if (a.type === 'COIN') {
    if (t.how !== 'coin' || t.coin) return t;
    const chooser: Pid = a.call === a.result ? a.player : a.player === 0 ? 1 : 0;
    return { ...t, coin: { by: a.player, call: a.call, result: a.result }, chooser };
  }
  if (a.type === 'FIRST') {
    if (t.chooser === null || a.player !== t.chooser || (a.first !== 0 && a.first !== 1)) return t;
    return { ...t, first: a.first };
  }
  return t;
}

export const isTossAction = (a: { type: string }): a is TossAction => a.type === 'TOSS' || a.type === 'RPS' || a.type === 'COIN' || a.type === 'FIRST';

export const randomHand = (rand: () => number = Math.random): Hand => HANDS[Math.floor(rand() * 3) % 3];
export const flipCoin = (rand: () => number = Math.random): CoinSide => (rand() < 0.5 ? 'heads' : 'tails');

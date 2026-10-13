// Reading a finished duel: the numbers stars and run scores are judged on.
import type { DuelState, Pid } from '../types';
import type { DuelOutcome, StarGoal } from './types';

export function outcomeOf(state: DuelState, me: Pid, myStartLp: number): DuelOutcome {
  const opp: Pid = me === 0 ? 1 : 0;
  const my = state.players[me];
  const result = state.winner === 'draw' || state.winner === null ? 'd' : state.winner === me ? 'w' : 'l';
  return {
    result,
    myLp: Math.max(0, my.lp),
    myStartLp,
    oppLp: Math.max(0, state.players[opp].lp),
    turns: state.turn,
    usedSkill: (my.skillUses ?? 0) > 0,
    myMonsters: my.mz.filter(Boolean).length,
  };
}

/** A loss for leaving halfway. */
export function forfeit(myStartLp: number): DuelOutcome {
  return { result: 'l', myLp: 0, myStartLp, oppLp: 1, turns: 0, usedSkill: false, myMonsters: 0, forfeit: true };
}

export const LP_STAR = 2000;

export function goalText(g: StarGoal): string {
  switch (g.kind) {
    case 'turns':
      return `Win by turn ${g.n}`;
    case 'noSkill':
      return 'Win without using your Skill';
    case 'lp':
      return `Win with ${g.n} or more LP`;
    case 'untouched':
      return 'Win without taking damage';
    case 'fullField':
      return 'Win with 3 monsters on your field';
  }
}

export const STAR_TEXT = (g: StarGoal) => ['Win the duel', `Win with ${LP_STAR}+ LP left`, goalText(g)];

function goalMet(g: StarGoal, o: DuelOutcome): boolean {
  switch (g.kind) {
    case 'turns':
      return o.turns <= g.n;
    case 'noSkill':
      return !o.usedSkill;
    case 'lp':
      return o.myLp >= g.n;
    case 'untouched':
      return o.myLp >= o.myStartLp;
    case 'fullField':
      return o.myMonsters >= 3;
  }
}

/** The three stars this duel earned (none without a win). */
export function starsFor(g: StarGoal, o: DuelOutcome): [boolean, boolean, boolean] {
  if (o.result !== 'w') return [false, false, false];
  return [true, o.myLp >= LP_STAR, goalMet(g, o)];
}

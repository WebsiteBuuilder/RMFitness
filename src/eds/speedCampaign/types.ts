// Shared shapes for the Speed Duel solo modes: the story campaign (The Millennium Road),
// the roguelite (Shadow Gauntlet) and Practice Duels.
import type { SeatSetup } from '../types';
import type { Tactics } from '../tactics';
import type { Difficulty } from '../difficulty';

/** A deck written compactly: "Card Name" or "Card Name*3". */
export type DeckList = string[];

/** One computer duelist: who they are, how they talk and what they play. */
export interface CpuDuelist {
  id: string;
  name: string;
  /** shown under the name: "Insect Duelist", "Gravekeeper Chief" */
  title: string;
  /** the card whose art stands in for their portrait */
  portrait: string;
  main: DeckList;
  extra: DeckList;
  skill: string | null;
  /** a line before the duel and lines after a win or a loss (theirs) */
  intro: string;
  onWin: string;
  onLose: string;
  /** cards that represent them (rewards, the trophy shelf) */
  signature: string[];
}

/**
 * A Duel Condition: how either side starts when it isn't the usual way. `text` is what
 * the player reads ("Pegasus starts with Toon World on the field").
 */
export interface DuelCondition {
  text: string;
  cpu?: SeatSetup;
  player?: SeatSetup;
  /** the computer goes first (otherwise a coin toss) */
  cpuFirst?: boolean;
}

/** A third star's goal, on top of "win" and "win with 2000+ LP left". */
export type StarGoal = { kind: 'turns'; n: number } | { kind: 'noSkill' } | { kind: 'lp'; n: number } | { kind: 'untouched' } | { kind: 'fullField' };

/** What the campaign or a run hands out. The reward sink decides what each one does. */
export type Reward =
  | { kind: 'card'; name: string }
  | { kind: 'skill'; name: string }
  | { kind: 'item'; name: string }
  | { kind: 'title'; name: string }
  | { kind: 'pack'; set?: string }
  | { kind: 'shards'; n: number }
  /** Duel Chips: the scarce currency the collection feature spends (capped) */
  | { kind: 'chips'; n: number };

/** What a finished duel looked like, for stars, rewards and run scoring. */
export interface DuelOutcome {
  result: 'w' | 'l' | 'd';
  myLp: number;
  myStartLp: number;
  oppLp: number;
  turns: number;
  usedSkill: boolean;
  myMonsters: number;
  /** left before the end (counts as a loss) */
  forfeit?: boolean;
}

/** Which solo mode a duel belongs to, so its result goes to the right place. */
export type DuelContext =
  | { kind: 'practice'; oppId: string; deckId: string | null; first: 'me' | 'cpu' | 'coin'; conditions: boolean; watch?: boolean }
  | { kind: 'campaign'; nodeId: string; open?: boolean }
  | { kind: 'labyrinth'; runId: string; stopId: string }
  | { kind: 'legend'; duelId: string; rematch?: boolean; open?: boolean };

/** Everything needed to start one duel against the computer. */
export interface CpuDuelSpec {
  me: { name: string; main: string[]; extra: string[]; skill: string | null; setup?: SeatSetup };
  cpu: { name: string; main: string[]; extra: string[]; skill: string | null; setup?: SeatSetup };
  first: 'me' | 'cpu' | 'coin';
  context: DuelContext;
  /** how sharp the computer plays (Normal when not set) */
  level?: Difficulty;
  /** the computer plays both sides, each with its own pep talk (Practice: watch a duel) */
  watch?: { tactics: [Tactics, Tactics] };
  /** a fixed duel shuffle (the Daily deals the same duels to everyone) */
  seed?: number;
  /** what the VS splash and the in-duel goal chip show */
  vs?: VsInfo;
  /** straight back in after a loss: the VS splash was seen a moment ago, so it's skipped */
  retry?: boolean;
}

export interface VsInfo {
  /** BOSS DUEL, ELITE DUEL, PRACTICE... */
  label: string;
  /** card art for each side */
  mePortrait: string;
  cpuPortrait: string;
  cpuTitle: string;
  line: string;
  /** Duel Conditions and run effects in play */
  notes: string[];
  /** the star goals, if any */
  goals: string[];
}

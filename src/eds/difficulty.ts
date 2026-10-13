// How hard the computer plays. Every level follows the same rules and never makes
// self-harming plays (Skills at full LP, equipping your monster, tributing its best monster
// for a little burn); the levels differ in how sharp it is:
// - Easy attacks often and simply: no lethal counting, no baiting traps, it summons the first
//   monster it finds and sometimes forgets its Extra Deck.
// - Normal counts lethal, baits Set cards with its weaker monsters, plays its effects well.
// - Hard also weighs every optional effect against the others and plays the best one first.

export type Difficulty = 'easy' | 'normal' | 'hard';
export const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
export const DIFFICULTY_NOTE: Record<Difficulty, string> = {
  easy: 'attacks a lot, plays simply',
  normal: 'counts lethal, baits your traps',
  hard: 'weighs every play against the others',
};

/** The Millennium Road: chapters 1-2 are Easy, 3-5 Normal, 6 and up Hard; a chapter's boss is one step harder. */
export function campaignDifficulty(chapter: number, boss = false): Difficulty {
  const base = chapter <= 2 ? 0 : chapter <= 5 ? 1 : 2;
  return DIFFICULTIES[Math.min(2, base + (boss ? 1 : 0))];
}

/** The Duel Labyrinth: floor 1 (index 0) Easy, floor 2 Normal, floor 3 Hard; bosses and a Curse of 3+ add a step. */
export function labyrinthDifficulty(floor: number, boss = false, curse = 0): Difficulty {
  return DIFFICULTIES[Math.max(0, Math.min(2, floor + (boss ? 1 : 0) + (curse >= 3 ? 1 : 0)))];
}

const KEY = 'eds.cpuLevel';
/** The level picked for Duel the Computer and Practice (Normal until changed). */
export function savedDifficulty(): Difficulty {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'easy' || v === 'normal' || v === 'hard') return v;
  } catch {
    /* storage blocked */
  }
  return 'normal';
}
export function saveDifficulty(d: Difficulty) {
  try {
    localStorage.setItem(KEY, d);
  } catch {
    /* storage blocked */
  }
}

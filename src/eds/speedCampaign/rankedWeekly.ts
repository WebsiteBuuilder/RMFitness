// Weekly Ranked Missions: every Monday four new missions on the Ranked ladder ("win 6 Ranked
// Duels", "beat 2 Wandering Duelists", "win going second"). Each one pays a pack the moment
// it's done, and clearing all four pays a Weekly Crown: one more pack and 2 Duel Chips.
//
// Everyone gets the same four in the same week (they're dealt from the week's date), so two
// brothers race for them. Only Ranked results move a mission on (Ranked Duels and the link
// battles that count on the ladder); leaving a duel never does. The week follows the ladder's
// clock, so turning the phone's date back can't bring back a week already played.
import { rng } from '../rng';
import { todayString } from './labyrinth';

/** What one Ranked result did, as far as missions care. */
export interface WeekEvent {
  result: 'w' | 'l' | 'd';
  /** stars won (a Pharaoh Point counts as a star) */
  gained: number;
  /** ranks climbed */
  rankUps: number;
  wandering: boolean;
  /** the computer went first */
  second: boolean;
  myLp: number;
  turns: number;
  /** an online link battle that counted on the ladder */
  link: boolean;
  usedSkill: boolean;
  /** left the duel (or closed the game): only ends a streak mission's run */
  left?: boolean;
}

export interface Mission {
  id: string;
  /** "Win 6 Ranked Duels" */
  text: string;
  n: number;
  /** how far one result moves it */
  step: (e: WeekEvent) => number;
  /** a streak mission: wins in a row this week, back to 0 on a Ranked loss (until it's done) */
  run?: boolean;
}

const win = (e: WeekEvent) => e.result === 'w';

/** Every mission there is: the week deals four of them, one from each group. */
export const MISSION_GROUPS: Mission[][] = [
  [
    { id: 'wins6', text: 'Win 6 Ranked Duels', n: 6, step: (e) => (win(e) ? 1 : 0) },
    { id: 'stars10', text: 'Earn 10 Ranked stars', n: 10, step: (e) => Math.max(0, e.gained) },
    { id: 'wins8', text: 'Win 8 Ranked Duels', n: 8, step: (e) => (win(e) ? 1 : 0) },
  ],
  [
    { id: 'streak3', text: 'Win 3 Ranked Duels in a row', n: 3, step: (e) => (e.link ? 0 : win(e) ? 1 : -1), run: true },
    { id: 'rankup2', text: 'Rank up twice (at Pharaoh: every 5 points)', n: 2, step: (e) => e.rankUps },
    { id: 'streak4', text: 'Win 4 Ranked Duels in a row', n: 4, step: (e) => (e.link ? 0 : win(e) ? 1 : -1), run: true },
  ],
  [
    { id: 'wander2', text: 'Beat 2 Wandering Duelists', n: 2, step: (e) => (win(e) && e.wandering ? 1 : 0) },
    { id: 'second2', text: 'Win 2 Ranked Duels going second', n: 2, step: (e) => (win(e) && e.second ? 1 : 0) },
    { id: 'fast', text: 'Win a Ranked Duel in 7 turns or fewer', n: 1, step: (e) => (win(e) && !e.link && e.turns <= 7 ? 1 : 0) },
  ],
  [
    { id: 'lp3000', text: 'Win 2 Ranked Duels with 3000+ LP left', n: 2, step: (e) => (win(e) && !e.link && e.myLp >= 3000 ? 1 : 0) },
    { id: 'skill2', text: 'Win 2 Ranked Duels using your Skill', n: 2, step: (e) => (win(e) && !e.link && e.usedSkill ? 1 : 0) },
    { id: 'play10', text: 'Finish 10 Ranked Duels (win or lose)', n: 10, step: (e) => (e.link ? 0 : 1) },
  ],
];

/** The week's first day (its Monday) by the local calendar: "2026-10-26". */
export function weekOf(now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return todayString(d);
}

/** When the week ends, for "3 days left". */
export function weekDaysLeft(now = new Date()): number {
  const [y, m, d] = weekOf(now).split('-').map(Number);
  const end = new Date(y, m - 1, d + 7);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86400000));
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** The week's four missions: one from each group, picked from the week's date. */
export function weekMissions(week: string): Mission[] {
  const next = rng(hash(`ranked-week#${week}`));
  return MISSION_GROUPS.map((g) => g[Math.floor(next() * g.length)]);
}

export interface WeekProgress {
  /** the week's Monday */
  id: string;
  /** progress on each of the four missions */
  prog: number[];
  /** missions already paid */
  paid: number[];
  /** the Weekly Crown was paid */
  crown?: boolean;
}

/** This week's progress (a fresh sheet once the week has turned). */
export function weekProgress(w: WeekProgress | undefined, now = new Date()): WeekProgress {
  const id = weekOf(now);
  return w?.id === id ? w : { id, prog: [0, 0, 0, 0], paid: [] };
}

/** Moves the week's missions on by one result. Returns the missions it finished. */
export function advanceWeek(w: WeekProgress | undefined, e: WeekEvent, now = new Date()): { week: WeekProgress; done: Mission[]; crown: boolean } {
  const cur = weekProgress(w, now);
  // a week never runs backwards: an older sheet can't be reopened by the clock
  if (w && w.id > cur.id) return { week: w, done: [], crown: false };
  const ms = weekMissions(cur.id);
  const prog = ms.map((m, i) => {
    const was = cur.prog[i] ?? 0;
    if (cur.paid.includes(i)) return m.n;
    if (e.left) return m.run ? 0 : was;
    const s = m.step(e);
    return m.run && s < 0 ? 0 : Math.min(m.n, was + s);
  });
  const done = ms.filter((m, i) => prog[i] >= m.n && !cur.paid.includes(i));
  const paid = [...cur.paid, ...ms.map((_, i) => i).filter((i) => prog[i] >= ms[i].n && !cur.paid.includes(i))];
  const crown = !cur.crown && paid.length === ms.length;
  return { week: { id: cur.id, prog, paid, ...(cur.crown || crown ? { crown: true } : {}) }, done, crown };
}

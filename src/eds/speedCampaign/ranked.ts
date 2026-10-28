// Ranked Duel: a monthly ladder against the computer, like Master Duel's Ranked. Every season
// is a calendar month. You climb from Rookie through Bronze, Silver, Gold, Platinum, Diamond,
// Master, Duel King and Legend to Pharaoh, the endless top tier, where every win is a Pharaoh
// Point; from Silver up a loss takes a star back and can drop you a rank, but never out of a
// tier you've reached. Each tier deals stronger opponents: Road
// duelists from later chapters, sharper play, and from Gold up Wandering Duelists with decks
// shuffled together for that one duel, so no two climbs meet the same table.
//
// What it pays (once per tier per season, so there is nothing to farm):
//  - reaching a tier for the first time this season pays its prize (packs, and Duel Chips
//    from Platinum up); Duel King, Legend and Pharaoh each add a title for the month
//  - Pharaoh Points pay a pack every TOP_MILESTONE, and every second one adds a chip
//  - Weekly Ranked Missions (rankedWeekly.ts) pay packs and a Weekly Crown
//  - a new season starts you two tiers below last season's best, and pays the prizes of the
//    tiers you start in, so a good month still pays the next one
// Bonus stars: the first win of each day is worth an extra star, and so is every win from
// the third in a row below Duel King (from there on, every star is earned one win at a time). Leaving a Ranked Duel (or closing the game mid-duel) counts as a loss.
// Own decks only: an Anything goes deck can't enter.
import { rng } from '../rng';
import { randomSpeedDeck } from '../speedRandom';
import { card } from '../db';
import type { SpeedSave } from '../speedSave';
import type { Difficulty } from '../difficulty';
import { CHAPTERS } from './roster';
import { deckOf } from './campaign';
import { grant } from './rewards';
import { todayString } from './labyrinth';
import type { SoloSave } from './save';
import type { CpuDuelist, DuelOutcome, Reward } from './types';
import { advanceWeek, type Mission, type WeekEvent, type WeekProgress } from './rankedWeekly';

export interface RankedTier {
  id: string;
  name: string;
  /** ranks in the tier (III, II then I); the top tier has one endless rank */
  ranks: number;
  /** stars a rank takes */
  stars: number;
  /** whether a loss takes a star */
  loses: boolean;
  level: Difficulty;
  /** Millennium Road chapters the opponents come from */
  chapters: number[];
  /** chance an opponent is a Wandering Duelist with a fresh random deck */
  wander: number;
  /** the Life Points the computer starts with, when not 4000 */
  cpuLp?: number;
  /** extra cards in the computer's opening hand */
  cpuHand?: number;
  prize: Reward[];
}


export const RANKED_TIERS: RankedTier[] = [
  { id: 'rookie', name: 'Rookie', ranks: 1, stars: 3, loses: false, level: 'easy', chapters: [1, 2], wander: 0, prize: [] },
  { id: 'bronze', name: 'Bronze', ranks: 2, stars: 3, loses: false, level: 'easy', chapters: [1, 2], wander: 0.15, prize: [{ kind: 'pack' }] },
  { id: 'silver', name: 'Silver', ranks: 3, stars: 3, loses: true, level: 'normal', chapters: [2, 3], wander: 0.2, prize: [{ kind: 'pack' }] },
  { id: 'gold', name: 'Gold', ranks: 3, stars: 4, loses: true, level: 'normal', chapters: [3, 4], wander: 0.25, prize: [{ kind: 'pack' }, { kind: 'pack' }] },
  { id: 'platinum', name: 'Platinum', ranks: 3, stars: 4, loses: true, level: 'hard', chapters: [4, 5], wander: 0.3, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 1 }] },
  { id: 'diamond', name: 'Diamond', ranks: 3, stars: 4, loses: true, level: 'hard', chapters: [5, 6], wander: 0.3, cpuLp: 4500, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 1 }] },
  { id: 'master', name: 'Master', ranks: 3, stars: 4, loses: true, level: 'hard', chapters: [6, 7], wander: 0.35, cpuLp: 5000, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 2 }] },
  { id: 'king', name: 'Duel King', ranks: 3, stars: 5, loses: true, level: 'hard', chapters: [7, 8], wander: 0.4, cpuLp: 5000, cpuHand: 1, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 3 }] },
  { id: 'legend', name: 'Legend', ranks: 3, stars: 5, loses: true, level: 'hard', chapters: [8], wander: 0.45, cpuLp: 5500, cpuHand: 1, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 3 }] },
  { id: 'pharaoh', name: 'Pharaoh', ranks: 1, stars: 0, loses: true, level: 'hard', chapters: [8], wander: 0.5, cpuLp: 6000, cpuHand: 1, prize: [{ kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'pack' }, { kind: 'chips', n: 4 }] },
];

/** One step of the ladder: a tier and its rank (2 = "II", 1 = "I"). */
export interface RankStep {
  tier: number;
  rank: number;
}
export const STEPS: RankStep[] = RANKED_TIERS.flatMap((t, tier) => Array.from({ length: t.ranks }, (_, i) => ({ tier, rank: t.ranks - i })));
export const TOP = STEPS.length - 1;
/** Duel King's tier: from here up, tiers pay a title and streaks stop adding stars. */
export const KING = RANKED_TIERS.findIndex((t) => t.id === 'king');
/** The tier a new season can start you in, at most (Master). */
const START_CAP = KING - 1;
/** The ladder before Duel King had ranks (Oct 2026): its top step, where old saves kept King points. */
const OLD_TOP = 18;

export const tierOf = (step: number) => RANKED_TIERS[STEPS[Math.max(0, Math.min(TOP, step))].tier];
/** Stars the rank at this step takes to climb. */
export const starsAt = (step: number) => tierOf(step).stars;
/** Pharaoh Points: every TOP_MILESTONE pays a pack (every second one a chip too), at most TOP_MILESTONES a season. */
export const TOP_MILESTONE = 5;
export const TOP_MILESTONES = 6;
/** Pharaoh Points that still pay this season. */
export const TOP_POINTS_PAYING = TOP_MILESTONE * TOP_MILESTONES;
/** The daily Ranked goal: this many Ranked wins in a day pays a pack. */
export const DAILY_GOAL = 3;
export const tierIndexOf = (step: number) => STEPS[Math.max(0, Math.min(TOP, step))].tier;
/** "Gold II", "Rookie", "Duel King I", "Pharaoh" */
export function stepName(step: number): string {
  const s = STEPS[Math.max(0, Math.min(TOP, step))];
  const t = RANKED_TIERS[s.tier];
  return t.ranks > 1 ? `${t.name} ${['', 'I', 'II', 'III'][s.rank]}` : t.name;
}
/** The tier's lowest step: a loss never drops you below it. */
export const tierFloor = (tier: number) => STEPS.findIndex((s) => s.tier === tier);

export interface SeasonRecord {
  season: string;
  peak: number;
  w: number;
  l: number;
  kp?: number;
}

export interface RankedProgress {
  /** "2026-10": the month this progress belongs to */
  season: string;
  step: number;
  /** stars in the current rank (below the rank's star count) */
  stars: number;
  /** Pharaoh Points: wins at the top, minus losses */
  kp: number;
  /** best step this season */
  peak: number;
  /** tiers whose prize this season already paid */
  paid: number[];
  /** wins in a row */
  streak: number;
  w: number;
  l: number;
  d?: number;
  /** Ranked Duels started this season (picks the next opponent, so backing out can't reroll it) */
  played: number;
  /** the last day the first-win bonus star was given */
  bonusDay?: string;
  /** Ranked wins today, for the daily goal: [day, wins] */
  today?: [string, number];
  /** the last day the daily goal paid its pack */
  goalDay?: string;
  /** King point milestones paid this season (the ladder before Pharaoh; kept for old saves) */
  kingPaid?: number;
  /** Pharaoh Point milestones paid this season */
  topPaid?: number;
  /** this week's Ranked Missions */
  week?: WeekProgress;
  /** 2 once the save has moved to the ladder with Legend and Pharaoh */
  v?: number;
  /** link-battle Ranked wins today, for the daily cap: [day, wins] */
  linkDay?: [string, number];
  /** the latest clock time the ladder has seen: days and seasons never run backwards from it */
  seen?: number;
  /** a Ranked Duel was started and not filed yet (closing the game mid-duel = a loss) */
  pending?: { season: string } | null;
  history: SeasonRecord[];
  deckId?: string | null;
  /** a new-season screen to show: last season's record and what the new one paid */
  news?: { last: SeasonRecord; start: number; lines: string[]; cards: string[] } | null;
}

/** The season a date falls in: its local calendar month. */
export const seasonOf = (now = new Date()) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** The season after this one: "2026-12" -> "2027-01". */
export function nextSeason(season: string): string {
  const [y, m] = season.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** "October 2026" */
export function seasonName(season: string): string {
  const [y, m] = season.split('-').map(Number);
  return `${MONTHS[(m - 1) % 12] ?? '?'} ${y}`;
}
/** Days until the season ends (1 on its last day). */
export function daysLeft(now = new Date()): number {
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 86400000));
}

export function newRanked(season: string): RankedProgress {
  return { season, step: 0, stars: 0, kp: 0, peak: 0, paid: [0], streak: 0, w: 0, l: 0, played: 0, history: [], v: 2 };
}
/** The ladder's clock: never earlier than the latest time it has seen, so setting the phone's
 * date back can't bring back a day's bonus, a daily pack or a season. */
export const ladderClock = (p: Pick<RankedProgress, 'seen'> | undefined, now = new Date()) => new Date(Math.max(now.getTime(), p?.seen ?? 0));
export const rankedProgress = (solo: SoloSave, now = new Date()): RankedProgress => solo.ranked ?? newRanked(seasonOf(now));

/** Wins a season needs before the next one starts you higher than Rookie (and pays those tiers). */
export const SEASON_MIN_WINS = 10;

/** Where a new season starts you: two tiers below last season's best (Master at most), at that tier's floor. */
export const seasonStart = (peak: number) => tierFloor(Math.max(0, Math.min(START_CAP, tierIndexOf(peak) - 2)));

/**
 * Moves a save from the first ladder (Duel King was one endless rank, step 18) to this one,
 * where Duel King has three ranks of 5 stars and Legend and Pharaoh sit above it. The King
 * points it had climb as stars from Duel King III, so nobody loses a win they earned.
 */
export function migrateRanked(p: RankedProgress): RankedProgress {
  if (p.v === 2) return p;
  let { step, stars, kp } = p;
  if (step === OLD_TOP) {
    for (; kp > 0; kp--) {
      if (step === TOP) break;
      if (++stars >= starsAt(step)) (step++, (stars = 0));
    }
    if (step !== TOP) kp = 0;
  }
  return { ...p, step, stars, kp, peak: Math.max(p.peak, step), v: 2 };
}

/** A prize as words: "2 packs + 1 Duel Chip". */
export function prizeText(prize: Reward[]): string {
  const packs = prize.filter((r) => r.kind === 'pack').length;
  const chips = prize.reduce((a, r) => a + (r.kind === 'chips' ? r.n : 0), 0);
  const out: string[] = [];
  if (packs) out.push(`${packs} pack${packs === 1 ? '' : 's'}`);
  if (chips) out.push(`${chips} chip${chips === 1 ? '' : 's'}`);
  return out.join(' + ') || 'nothing';
}

/** Pays every tier up to `tier` not yet paid this season. */
function payTiers(speed: SpeedSave, solo: SoloSave, p: RankedProgress, tier: number, seed: number, season: string) {
  const rewards: Reward[] = [];
  const paid = [...p.paid];
  for (let t = 1; t <= tier; t++) {
    if (paid.includes(t)) continue;
    paid.push(t);
    rewards.push(...RANKED_TIERS[t].prize);
    if (t >= KING) rewards.push({ kind: 'title', name: `${RANKED_TIERS[t].name} · ${seasonName(season)}` });
  }
  if (!rewards.length) return { speed, solo, paid, lines: [] as string[], cards: [] as string[], chipsDue: 0 };
  const g = grant(speed, solo, rewards, [], seed);
  return { speed: g.speed, solo: g.solo, paid, lines: g.lines, cards: g.cards, chipsDue: rewards.reduce((a, r) => a + (r.kind === 'chips' ? r.n : 0), 0) };
}

export interface RankedOpened {
  speed: SpeedSave;
  solo: SoloSave;
  /** a Ranked Duel left unfinished (the game was closed) was filed as a loss */
  forfeited: boolean;
}

/**
 * Brings the ladder up to date when its screen opens: files a Ranked Duel that was never
 * finished as a loss, and starts a new season when the month has turned (paying the prizes
 * of the tiers it starts you in). Seasons only move forward, so turning the clock back
 * can't replay one.
 */
export function openRanked(speed: SpeedSave, solo: SoloSave, now = new Date(), seed = now.getTime()): RankedOpened {
  now = ladderClock(solo.ranked, now);
  let p: RankedProgress = { ...migrateRanked(rankedProgress(solo, now)), seen: now.getTime() };
  let forfeited = false;
  if (p.pending) {
    p = applyResult(p, 'l', now, true).p;
    forfeited = true;
  }
  const season = seasonOf(now);
  if (season > p.season) {
    const last: SeasonRecord = { season: p.season, peak: p.peak, w: p.w, l: p.l, ...(p.kp ? { kp: p.kp } : {}) };
    const played = p.w + p.l + (p.d ?? 0) > 0;
    // the soft reset (and its starting prizes) needs a real season behind it: SEASON_MIN_WINS wins
    // and must be the season just before this one (a skipped month, or a clock jumped ahead, starts fresh)
    const start = p.w >= SEASON_MIN_WINS && season === nextSeason(p.season) ? seasonStart(p.peak) : 0;
    const fresh: RankedProgress = { ...newRanked(season), step: start, peak: start, history: played ? [last, ...p.history].slice(0, 24) : p.history, deckId: p.deckId, seen: p.seen, ...(p.week ? { week: p.week } : {}) };
    const pay = payTiers(speed, solo, fresh, tierIndexOf(start), seed, season);
    p = { ...fresh, paid: pay.paid, news: played ? { last, start, lines: pay.lines, cards: pay.cards } : null };
    return { speed: pay.speed, solo: { ...pay.solo, ranked: p }, forfeited };
  }
  return { speed, solo: { ...solo, ranked: p }, forfeited };
}

/** Ranked wins so far today (for the daily goal). */
export function winsToday(p: RankedProgress, now = new Date()): number {
  return p.today?.[0] === todayString(now) ? p.today[1] : 0;
}
/** Wins still needed to climb out of this rank (ignoring bonus stars), or null at the top. */
export const starsToNext = (p: Pick<RankedProgress, 'step' | 'stars'>) => (p.step === TOP ? null : starsAt(p.step) - p.stars);

/** Marks a Ranked Duel as started: the next opponent is dealt, and leaving now counts as a loss. */
export function startRanked(solo: SoloSave, now = new Date()): SoloSave {
  const p = rankedProgress(solo, now);
  return { ...solo, ranked: { ...p, played: p.played + 1, pending: { season: p.season } } };
}

/** A Ranked Duel backed out of before it started: no result, and the same opponent comes back. */
export function cancelRanked(solo: SoloSave): SoloSave {
  const p = solo.ranked;
  if (!p?.pending) return solo;
  return { ...solo, ranked: { ...p, pending: null, played: Math.max(0, p.played - 1) } };
}

/** What a result does to the ladder (no prizes): stars, ranks, the streak and the record. */
function applyResult(p: RankedProgress, result: 'w' | 'l' | 'd', now: Date, forfeit = false, link = false) {
  let { step, stars, kp, streak } = p;
  let gained = 0;
  let bonus = false;
  let streakBonus = false;
  const today = todayString(now);
  let bonusDay = p.bonusDay;
  if (result === 'w') {
    gained = 1;
    // a link battle is one plain star: the daily bonus and the streak belong to Ranked Duels
    if (!link) {
      streak += 1;
      if (bonusDay !== today) (gained++, (bonus = true), (bonusDay = today));
      if (streak >= 3 && tierIndexOf(step) < KING) (gained++, (streakBonus = true));
    }
    for (let i = 0; i < gained; i++) {
      if (step === TOP) kp++;
      else if (++stars >= starsAt(step)) (step++, (stars = 0));
    }
  } else if (result === 'l') {
    if (!link) streak = 0;
    const t = tierIndexOf(step);
    // leaving costs a star even in the tiers where losing doesn't, so quitting can't redraw a bad start
    if (RANKED_TIERS[t].loses || forfeit) {
      // -1 only when a star (or King point) was really taken: at a tier's floor with none left, nothing goes
      if (step === TOP) kp > 0 && (kp--, (gained = -1));
      else if (stars > 0) (stars--, (gained = -1));
      else if (step > tierFloor(t)) (step--, (stars = starsAt(step) - 1), (gained = -1));
    }
    // leaving with nothing to take still costs something: today's first-win bonus star
    if (forfeit && gained === 0) bonusDay = today;
  } else if (!link) streak = 0;
  const next: RankedProgress = {
    ...p,
    step,
    stars,
    kp,
    streak,
    bonusDay,
    peak: Math.max(p.peak, step),
    w: p.w + (result === 'w' ? 1 : 0),
    l: p.l + (result === 'l' ? 1 : 0),
    ...(result === 'd' ? { d: (p.d ?? 0) + 1 } : {}),
    pending: null,
  };
  return { p: next, gained, bonus, streakBonus };
}

export interface RankedSettled {
  speed: SpeedSave;
  solo: SoloSave;
  before: { step: number; stars: number; kp: number };
  after: { step: number; stars: number; kp: number };
  /** stars won (or -1 for one lost; 0 when the tier keeps it) */
  gained: number;
  bonus: boolean;
  streakBonus: boolean;
  streak: number;
  /** a tier reached for the first time this season (its prize was paid) */
  newTier: RankedTier | null;
  lines: string[];
  cards: string[];
  capped: boolean;
  forfeit: boolean;
  /** the day's Ranked goal paid its pack */
  goalPaid: boolean;
  /** a Pharaoh Point milestone paid */
  topPaid: boolean;
  /** Weekly Missions finished by this duel */
  missions: Mission[];
  /** the Weekly Crown (all four missions) was paid */
  crown: boolean;
}

/** What only the duel itself knows: whether the opponent was a Wandering Duelist, and who went first. */
export interface RankedDuelInfo {
  wandering?: boolean;
  second?: boolean;
}

/** Ranks climbed (or fallen, negative) between two steps. */
const rankUps = (from: number, to: number) => Math.max(0, to - from);

/** Moves the Weekly Missions on and pays any it finished: a pack each, and the Weekly Crown. */
function payWeek(speed: SpeedSave, solo: SoloSave, next: RankedProgress, e: WeekEvent, now: Date, seed: number) {
  const w = advanceWeek(next.week, e, now);
  next = { ...next, week: w.week };
  const rewards: Reward[] = [...w.done.map(() => ({ kind: 'pack' }) as Reward), ...(w.crown ? ([{ kind: 'pack' }, { kind: 'chips', n: WEEKLY_CROWN_CHIPS }] as Reward[]) : [])];
  if (!rewards.length) return { speed, solo, next, lines: [] as string[], cards: [] as string[], done: w.done, crown: w.crown };
  const g = grant(speed, solo, rewards, [], seed);
  return { speed: g.speed, solo: g.solo, next, lines: g.lines, cards: g.cards, done: w.done, crown: w.crown };
}
/** Duel Chips the Weekly Crown pays. */
export const WEEKLY_CROWN_CHIPS = 2;

/** Pharaoh Point milestones due at this many points (TOP_MILESTONES a season at most). */
export const topDue = (kp: number) => Math.min(TOP_MILESTONES, Math.floor(kp / TOP_MILESTONE));
/** The reward for reaching milestone i (0-based): a pack, and a chip on every second one. */
const topReward = (i: number): Reward[] => [{ kind: 'pack' }, ...(i % 2 === 1 ? ([{ kind: 'chips', n: 1 }] as Reward[]) : [])];

/** Files a Ranked Duel: stars and ranks, and the prize of any tier reached for the first time this season. */
export function settleRanked(speed: SpeedSave, solo: SoloSave, o: DuelOutcome, now = new Date(), seed = now.getTime(), info: RankedDuelInfo = {}): RankedSettled {
  // The month may have turned during the duel: the result goes to the season you're in now.
  const opened = openRanked(speed, { ...solo, ranked: solo.ranked ? { ...solo.ranked, pending: null } : solo.ranked }, now, seed);
  speed = opened.speed;
  solo = opened.solo;
  now = ladderClock(solo.ranked, now);
  seed += 101;
  const p = rankedProgress(solo, now);
  const before = { step: p.step, stars: p.stars, kp: p.kp };
  const r = applyResult(p, o.forfeit ? 'l' : o.result, now, !!o.forfeit);
  const tierNow = tierIndexOf(r.p.step);
  let newTier: RankedTier | null = null;
  let lines: string[] = [];
  let cards: string[] = [];
  let capped = false;
  let next = r.p;
  if (tierNow > 0 && !p.paid.includes(tierNow)) {
    const pay = payTiers(speed, solo, r.p, tierNow, seed, r.p.season);
    if (pay.lines.length) newTier = RANKED_TIERS[tierNow];
    capped = pay.chipsDue > 0 && (pay.speed.chips ?? 0) - (speed.chips ?? 0) < pay.chipsDue;
    speed = pay.speed;
    solo = pay.solo;
    lines = pay.lines;
    cards = pay.cards;
    next = { ...next, paid: pay.paid };
  }
  // The daily goal (a pack for the day's third Ranked win) and Pharaoh milestones (a pack every 5 points, a chip every 10).
  const extra: Reward[] = [];
  let goalPaid = false;
  let topPaid = false;
  if (o.result === 'w' && !o.forfeit) {
    const day = todayString(now);
    const counts = RANKED_TIERS[tierIndexOf(p.step)].loses;
    const wins = (next.today?.[0] === day ? next.today[1] : 0) + (counts ? 1 : 0);
    next = { ...next, today: [day, wins] };
    // only wins where a loss costs stars count toward it, so it can't be farmed against the easy tiers
    if (wins >= DAILY_GOAL && next.goalDay !== day && RANKED_TIERS[tierIndexOf(p.step)].loses) {
      extra.push({ kind: 'pack' });
      next = { ...next, goalDay: day };
      goalPaid = true;
    }
    const due = topDue(next.kp);
    if (next.step === TOP && due > (next.topPaid ?? 0)) {
      for (let i = next.topPaid ?? 0; i < due; i++) extra.push(...topReward(i));
      next = { ...next, topPaid: due };
      topPaid = true;
    }
  }
  const chipsBefore = speed.chips ?? 0;
  const chipsDue = extra.reduce((a, r) => a + (r.kind === 'chips' ? r.n : 0), 0);
  if (extra.length) {
    const g = grant(speed, solo, extra, [], seed + 7);
    speed = g.speed;
    solo = g.solo;
    lines = [...lines, ...g.lines];
    cards = [...cards, ...g.cards];
    capped ||= chipsDue > 0 && (speed.chips ?? 0) - chipsBefore < chipsDue;
  }
  // Weekly Missions: a left duel moves nothing
  let missions: Mission[] = [];
  let crown = false;
  if (!o.forfeit) {
    const ev: WeekEvent = { result: o.result, gained: Math.max(0, r.gained), rankUps: rankUps(p.step, next.step), wandering: !!info.wandering, second: !!info.second, myLp: o.myLp, turns: o.turns, link: false };
    const wk = payWeek(speed, solo, next, ev, now, seed + 13);
    speed = wk.speed;
    solo = wk.solo;
    next = wk.next;
    missions = wk.done;
    crown = wk.crown;
    lines = [...lines, ...wk.lines];
    cards = [...cards, ...wk.cards];
  }
  return {
    speed,
    solo: { ...solo, ranked: next },
    before,
    after: { step: next.step, stars: next.stars, kp: next.kp },
    gained: r.gained,
    bonus: r.bonus,
    streakBonus: r.streakBonus,
    streak: next.streak,
    newTier,
    lines,
    cards,
    capped,
    forfeit: !!o.forfeit,
    goalPaid,
    topPaid,
    missions,
    crown,
  };
}

// ---------- opponents ----------

/** Who goes first in the next Ranked Duel: fixed with the opponent, so backing out can't redo the toss. */
export const rankedFirst = (p: RankedProgress): 'me' | 'cpu' => (hash(`${p.season}#${p.played}#first`) % 2 ? 'me' : 'cpu');

/** Small stable hash, for picking the next opponent from the season and match count. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

const WANDERERS: { name: string; title: string; intro: string; onWin: string; onLose: string }[] = [
  { name: 'Rare Hunter', title: 'Wandering Duelist', intro: "Nobody's seen this deck before. Not even me.", onWin: 'Your rank is mine.', onLose: "Tch. I'll shuffle a better one." },
  { name: 'Duel Monster Drifter', title: 'Wandering Duelist', intro: 'I build a new deck every town I pass through. Today it meets you.', onWin: 'On to the next town.', onLose: 'Good duel. The road goes on.' },
  { name: 'Masked Challenger', title: 'Wandering Duelist', intro: 'No name. No rank. Just a deck and a grudge.', onWin: 'Remember the mask.', onLose: 'The mask cracks... well played.' },
  { name: 'Card Tycoon', title: 'Wandering Duelist', intro: 'I bought every pack in the shop and made a deck out of the pile.', onWin: 'Money talks!', onLose: 'Should have bought more packs.' },
  { name: 'Kaiba Corp Tester', title: 'Wandering Duelist', intro: 'Prototype deck, test run 417. Please do not hold back.', onWin: 'Test passed.', onLose: 'Logging the failure. Thank you.' },
  { name: 'Battle City Entrant', title: 'Wandering Duelist', intro: 'Two Locator Cards so far. Yours makes three.', onWin: 'Hand over that Locator Card!', onLose: "There's always the next block." },
  { name: 'Academy Dropout', title: 'Wandering Duelist', intro: "They said my decks were too random. I said that's the point.", onWin: 'Random beats ranked!', onLose: 'Maybe they had a point.' },
  { name: 'Ghost of the Arena', title: 'Wandering Duelist', intro: 'I lost every duel I played when I was alive. Not tonight.', onWin: 'At last... a win.', onLose: 'Back to the shadows.' },
];

export interface RankedFoe {
  duelist: CpuDuelist;
  main: string[];
  extra: string[];
  wandering: boolean;
}

/** The next Ranked opponent: the same until you start the duel, so backing out can't reroll it. */
export function rankedFoe(p: RankedProgress): RankedFoe {
  const t = tierOf(p.step);
  const next = rng(hash(`${p.season}#${p.played}`));
  if (next() < t.wander) {
    const w = WANDERERS[Math.floor(next() * WANDERERS.length)];
    const styles = ['balanced', 'beatdown', 'control'] as const;
    const d = randomSpeedDeck(undefined, { size: 24 + Math.floor(next() * 5), style: styles[Math.floor(next() * 3)], theme: { kind: 'surprise' }, rand: next });
    if (!('error' in d)) {
      const ace = [...d.main, ...d.extra].filter((n) => card(n)?.kind === 'monster').sort((a, b) => (card(b)?.atk ?? 0) - (card(a)?.atk ?? 0))[0] ?? d.main[0];
      const duelist: CpuDuelist = { id: `wander-${p.season}-${p.played}`, ...w, title: `${w.title} · ${d.label}`, portrait: ace, main: d.main, extra: d.extra, skill: d.skill, signature: [ace] };
      return { duelist, main: d.main, extra: d.extra, wandering: true };
    }
  }
  const pool = CHAPTERS.filter((c) => t.chapters.includes(c.n)).flatMap((c) => c.nodes.map((n) => n.duelist));
  const duelist = pool[Math.floor(next() * pool.length)];
  return { duelist, ...deckOf(duelist), wandering: false };
}

// ---------- link battles ----------

/** Link-battle wins that can earn a Ranked star each day (so two phones can't farm the ladder). */
export const LINK_STARS_PER_DAY = 3;

export interface LinkRanked {
  speed: SpeedSave;
  solo: SoloSave;
  /** what to tell the player, or null when the duel didn't touch the ladder */
  line: string | null;
  /** tier prize lines and cards, when a link win reached a new tier */
  lines: string[];
  cards: string[];
}

/**
 * A finished online link battle against a rival also counts on the Ranked ladder: a win is one
 * star (up to LINK_STARS_PER_DAY a day), a loss takes one where Ranked losses do. No bonus or
 * streak stars, no daily pack; a new tier still pays its season prize once. The caller only sends
 * real duels (online, a few turns, not a quick surrender).
 */
export function settleLinkRanked(speed: SpeedSave, solo: SoloSave, result: 'w' | 'l' | 'd', opp: string, now = new Date(), seed = now.getTime()): LinkRanked {
  const opened = openRanked(speed, solo, now, seed);
  speed = opened.speed;
  solo = opened.solo;
  now = ladderClock(solo.ranked, now);
  const p = rankedProgress(solo, now);
  const day = todayString(now);
  const used = p.linkDay?.[0] === day ? p.linkDay[1] : 0;
  if (result === 'd' || (result === 'w' && used >= LINK_STARS_PER_DAY)) {
    return { speed, solo, line: result === 'w' ? `Ranked: today's ${LINK_STARS_PER_DAY} link-battle stars are already won` : null, lines: [], cards: [] };
  }
  const r = applyResult(p, result, now, false, true);
  let next: RankedProgress = { ...r.p, ...(result === 'w' ? { linkDay: [day, used + 1] as [string, number] } : {}) };
  let lines: string[] = [];
  let cards: string[] = [];
  const tierNow = tierIndexOf(next.step);
  if (tierNow > 0 && !p.paid.includes(tierNow)) {
    const pay = payTiers(speed, solo, next, tierNow, seed + 31, next.season);
    speed = pay.speed;
    solo = pay.solo;
    lines = pay.lines;
    cards = pay.cards;
    next = { ...next, paid: pay.paid };
  }
  const wk = payWeek(speed, solo, next, { result, gained: Math.max(0, r.gained), rankUps: rankUps(p.step, next.step), wandering: false, second: false, myLp: 0, turns: 0, link: true }, now, seed + 47);
  speed = wk.speed;
  solo = wk.solo;
  next = wk.next;
  lines = [...lines, ...wk.lines];
  cards = [...cards, ...wk.cards];
  const missionLines = [...wk.done.map((m) => `Weekly mission done: ${m.text}`), ...(wk.crown ? ['Weekly Crown: every mission this week done!'] : [])];
  const where = next.step === TOP ? `${next.kp} Pharaoh Points` : `${stepName(next.step)}, ${next.stars}/${starsAt(next.step)} stars`;
  const line =
    r.gained > 0 ? `Ranked: +1 star for beating ${opp} (${where})${next.step > p.step ? ' · rank up!' : ''}` : r.gained < 0 ? `Ranked: −1 star for losing to ${opp} (${where})` : null;
  return { speed, solo: { ...solo, ranked: next }, line: line && missionLines.length ? [line, ...missionLines].join(' · ') : line, lines, cards };
}

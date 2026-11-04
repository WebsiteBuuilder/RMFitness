// What the Duel Pass has handed this duelist for good: plain data, read by the sleeve, playmat,
// frame, name plate and title code without pulling in the whole pass (no import cycles).
import type { SpeedSave } from '../eds/speedSave';

/** The save fields the Duel Pass keeps (on the Speed Duel save, so they sync with the profile). */
export interface PassFields {
  /** this season's track */
  pass?: PassTrack;
  /** cosmetics the pass gave for good ("sleeve:champion", "frame:gold", "title:rookie", ...) */
  passOwn?: string[];
  /** what this duelist wears from it: a title, a name plate and an avatar frame (ids) */
  wear?: { title?: string; plate?: string; frame?: string };
}

export interface PassTrack {
  /** the season ("2026-11"; one a month, like Ranked) */
  season: string;
  xp: number;
  /** the Duel Chips lane is open */
  prem: boolean;
  /** tiers whose free / Chips-lane rewards are claimed */
  gotF: number[];
  gotP: number[];
  /** today, and the XP earned today (the daily cap) */
  day: string;
  dayXp: number;
  /** today's first win bonus was paid */
  firstWin: boolean;
}

export const passOf = (s: SpeedSave | null | undefined) => s as (SpeedSave & PassFields) | null | undefined;

/** Did the Duel Pass give this duelist that cosmetic ("sleeve:id", "mat:id", ...)? */
export const passOwns = (s: SpeedSave | null | undefined, key: string): boolean => !!passOf(s)?.passOwn?.includes(key);

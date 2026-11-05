// Pack opening ceremony: the pure part. Every pulled card gets one "grade" from the rarity
// its set prints it at and the finish it came out at, and the ceremony is paced from it:
// which cards glow through their backs, which one waits last behind a hold-to-reveal,
// what the torn pack's light foreshadows, and which pulls a big batch puts in the spotlight.
// Nothing here touches the save, the odds or what a pack holds: it only reads a pack
// that economy.ts already opened.
import type { Rarity } from '../collection/sets';

/** Common, Rare, Super, Ultra, Secret, Glossy, Royal, Overframe: the order a pull is celebrated in. */
export const GRADES = ['n', 'r', 'sr', 'ur', 'scr', 'gl', 'ro', 'of'] as const;
export type Grade = (typeof GRADES)[number];
export const GRADE_NAME: Record<Grade, string> = {
  n: 'Common',
  r: 'Rare',
  sr: 'Super Rare',
  ur: 'Ultra Rare',
  scr: 'Secret Rare',
  gl: 'Glossy Ultra Rare',
  ro: 'Royal Ultra Rare',
  of: 'Overframe',
};

/** From this grade up a card glows through its back before it is flipped. */
export const TEASE_FROM = 2;
/** From this grade up a pack's best card waits last, behind a hold-to-reveal. */
export const STAR_FROM = 3;
/** The most pulls a batch of packs puts in the spotlight before its results. */
export const SPOTLIGHT_MAX = 5;

const FLOOR: Record<Rarity, number> = { Common: 0, Rare: 1, 'Super Rare': 2, 'Ultra Rare': 3, 'Secret Rare': 4 };

/**
 * One card's grade (an index into GRADES). `finish` is the TIERS index it came out at
 * (finish.ts): Glossy, Royal and Overframe outrank every printed rarity; below them the
 * printed rarity is the floor and a Secret Rare sits just above an Ultra Rare.
 */
export function gradeOf(printed: Rarity | undefined, finish = 0): number {
  const f = Math.max(0, Math.floor(finish || 0));
  if (f >= 4) return Math.min(GRADES.length - 1, f + 1);
  return Math.max(FLOOR[printed ?? 'Common'] ?? 0, Math.min(3, f));
}

/** The card the pack saves for last (the best, the rightmost of equals), or -1 when nothing earns a hold. */
export function starOf(grades: number[]): number {
  let at = -1;
  grades.forEach((g, i) => {
    if (g >= STAR_FROM && (at < 0 || g >= grades[at])) at = i;
  });
  return at;
}

/** The order "next" and "flip all" go in: left to right, the star last. */
export function flipOrder(grades: number[]): number[] {
  const star = starOf(grades);
  const order = grades.map((_, i) => i).filter((i) => i !== star);
  return star >= 0 ? [...order, star] : order;
}

/** The next face-down card a swipe flips (-1 once all are up). */
export function nextToFlip(grades: number[], up: boolean[]): number {
  return flipOrder(grades).find((i) => !up[i]) ?? -1;
}

/** What the light out of a freshly torn pack hints at: its best grade. */
export const foreshadow = (grades: number[]) => Math.max(0, ...grades);

/**
 * The pulls a batch of packs shows one by one before its results: Ultra Rare or better,
 * best last, at most SPOTLIGHT_MAX (the best ones). A batch with none shows its single best
 * Super Rare, and a batch of plain cards goes straight to the results.
 */
export function spotlight(grades: number[], max = SPOTLIGHT_MAX): number[] {
  const idx = grades.map((g, i) => ({ g, i }));
  let picks = idx.filter((x) => x.g >= STAR_FROM);
  if (!picks.length) picks = idx.filter((x) => x.g >= TEASE_FROM).sort((a, b) => b.g - a.g || a.i - b.i).slice(0, 1);
  // keep the best `max`, then show them weakest first so the batch ends on its top pull
  return picks
    .sort((a, b) => b.g - a.g || a.i - b.i)
    .slice(0, Math.max(0, max))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.i);
}

/** How long a pull holds the stage, in ms (the flash, the sound): bigger pulls take a beat longer. */
export const beatOf = (g: number) => [260, 380, 650, 900, 1000, 1150, 1250, 1500][Math.max(0, Math.min(GRADES.length - 1, g))];

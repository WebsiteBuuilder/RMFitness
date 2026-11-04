// Monster idle life: how each monster standing on the field moves while nothing happens,
// so the board never looks frozen. Pure (no DOM, no three.js), so the tests can read it and
// board.ts only adds numbers to the pose it already builds every frame.
//
//   Temperament (from its Type): a Dragon heaves deep, slow breaths; a Fairy or a Winged Beast
//   hovers over its card with its shadow shrinking under it; a Machine hums and turns in
//   small servo steps; a Fiend or a Zombie sways unevenly; a Warrior shifts its weight;
//   a Fish or an Aqua monster undulates; an Insect or a Plant twitches; a Rock barely moves.
//   Motes (from its Attribute): embers rise off a FIRE monster, bubbles off WATER, leaves
//   swirl round WIND, dust drifts off EARTH, sparkles off LIGHT, smoke curls off DARK,
//   gold dust off DIVINE.
//   Presence: a boss (Level 7+ or 2500+ printed ATK) carries a slow aura; your Ace a gold one.
//   Moods: braced and shivering while an attack or effect is aimed at it, battle-worn
//   (hunched, heavy breaths) for a while after it survives a hit, tense (quick shallow
//   breaths) while its duelist is in danger, and a glance at a monster that just arrived.

export type Temper = 'heavy' | 'hover' | 'machine' | 'stalker' | 'warrior' | 'wave' | 'twitch' | 'stone' | 'calm';

export interface IdleStyle {
  temper: Temper;
  /** breathing: scale amplitude (share of size) and rate (rad/s) */
  breathAmp: number;
  breathRate: number;
  /** hovering height over the card (share of the card's width) and its bob */
  hover: number;
  bobAmp: number;
  bobRate: number;
  /** turning left/right (rad) and rate */
  swayAmp: number;
  swayRate: number;
  /** rocking side to side (rad) and rate */
  rollAmp: number;
  rollRate: number;
  /** servo steps per second for the turn (0 = smooth) */
  steps: number;
  /** a fine hum (rad), Machines */
  hum: number;
  /** a random little twitch now and then (0..1 how often) */
  twitch: number;
}

const BASE: IdleStyle = {
  temper: 'calm',
  breathAmp: 0.012,
  breathRate: 1.9,
  hover: 0,
  bobAmp: 0,
  bobRate: 1.2,
  swayAmp: 0.14,
  swayRate: 0.45,
  rollAmp: 0.02,
  rollRate: 0.7,
  steps: 0,
  hum: 0,
  twitch: 0,
};

const TEMPERS: Record<Temper, Partial<IdleStyle>> = {
  calm: {},
  heavy: { breathAmp: 0.024, breathRate: 1.25, swayAmp: 0.1, swayRate: 0.32, rollAmp: 0.015, rollRate: 0.5 },
  hover: { breathAmp: 0.01, breathRate: 1.7, hover: 0.07, bobAmp: 0.035, bobRate: 1.5, swayAmp: 0.16, rollAmp: 0.035, rollRate: 0.9 },
  machine: { breathAmp: 0, swayAmp: 0.16, swayRate: 0.5, rollAmp: 0.008, steps: 3, hum: 0.006 },
  stalker: { breathAmp: 0.014, breathRate: 1.4, swayAmp: 0.18, swayRate: 0.36, rollAmp: 0.05, rollRate: 0.55 },
  warrior: { breathAmp: 0.014, breathRate: 1.8, swayAmp: 0.12, swayRate: 0.4, rollAmp: 0.04, rollRate: 0.62 },
  wave: { breathAmp: 0.012, breathRate: 1.6, swayAmp: 0.12, rollAmp: 0.06, rollRate: 1.1, bobAmp: 0.012, bobRate: 1.1 },
  twitch: { breathAmp: 0.012, breathRate: 2.6, swayAmp: 0.1, rollAmp: 0.02, twitch: 1 },
  stone: { breathAmp: 0.004, breathRate: 0.9, swayAmp: 0.05, swayRate: 0.25, rollAmp: 0.006 },
};

const RACE_TEMPER: Record<string, Temper> = {
  Dragon: 'heavy',
  Dinosaur: 'heavy',
  Beast: 'heavy',
  Wyrm: 'heavy',
  Reptile: 'heavy',
  'Sea Serpent': 'wave',
  Fish: 'wave',
  Aqua: 'wave',
  Fairy: 'hover',
  'Winged Beast': 'hover',
  Spellcaster: 'hover',
  Psychic: 'hover',
  'Divine-Beast': 'hover',
  Thunder: 'hover',
  Machine: 'machine',
  Cyberse: 'machine',
  Fiend: 'stalker',
  Zombie: 'stalker',
  Illusion: 'stalker',
  Warrior: 'warrior',
  'Beast-Warrior': 'warrior',
  Pyro: 'warrior',
  Insect: 'twitch',
  Plant: 'twitch',
  Rock: 'stone',
};

export function temperOf(race: string | undefined): Temper {
  return RACE_TEMPER[race ?? ''] ?? 'calm';
}

/** How a monster idles, from its Type (a big monster breathes slower and deeper). */
export function idleStyleFor(race: string | undefined, level = 4): IdleStyle {
  const temper = temperOf(race);
  const s: IdleStyle = { ...BASE, ...TEMPERS[temper], temper };
  if (level >= 7 && s.breathAmp > 0) {
    s.breathAmp *= 1.2;
    s.breathRate *= 0.85;
  }
  return s;
}

export type MoteKind = 'ember' | 'bubble' | 'leaf' | 'dust' | 'spark' | 'smoke' | 'divine';

export interface MoteStyle {
  kind: MoteKind;
  /** two colors it picks between */
  color: number;
  color2: number;
  /** motes per second around one monster */
  rate: number;
  /** upward speed (share of the card's width per second); negative falls */
  rise: number;
  /** sideways wander (share of card width per second) */
  drift: number;
  /** seconds */
  life: number;
  /** start and end size (share of the card's width) */
  size: number;
  size1: number;
  /** a swirl around the monster (WIND) */
  swirl: number;
}

const MOTES: Record<string, MoteStyle> = {
  FIRE: { kind: 'ember', color: 0xff6a12, color2: 0xffb03a, rate: 4.6, rise: 0.42, drift: 0.1, life: 1.5, size: 0.34, size1: 0.12, swirl: 0 },
  WATER: { kind: 'bubble', color: 0x6fd8ff, color2: 0xc8f4ff, rate: 3.2, rise: 0.3, drift: 0.06, life: 1.8, size: 0.13, size1: 0.21, swirl: 0 },
  WIND: { kind: 'leaf', color: 0x7cf2a0, color2: 0xd8ffc0, rate: 3.4, rise: 0.16, drift: 0.05, life: 2.2, size: 0.24, size1: 0.2, swirl: 1 },
  EARTH: { kind: 'dust', color: 0xd8a860, color2: 0xb89870, rate: 3.0, rise: 0.08, drift: 0.14, life: 2.4, size: 0.16, size1: 0.26, swirl: 0 },
  LIGHT: { kind: 'spark', color: 0xfff2b0, color2: 0xffffff, rate: 3.6, rise: 0.22, drift: 0.05, life: 1.4, size: 0.3, size1: 0.05, swirl: 0 },
  DARK: { kind: 'smoke', color: 0x7a3ae0, color2: 0x4a2a9a, rate: 3.0, rise: 0.16, drift: 0.06, life: 2.6, size: 0.26, size1: 0.6, swirl: 0 },
  DIVINE: { kind: 'divine', color: 0xffd65a, color2: 0xfff4c0, rate: 5.0, rise: 0.34, drift: 0.07, life: 1.7, size: 0.32, size1: 0.06, swirl: 0.5 },
};

/** The shape each kind of mote is drawn in (stage.ts M_FRAG). */
export const MOTE_SHAPE: Record<MoteKind, number> = { ember: 0, bubble: 1, leaf: 2, dust: 3, spark: 4, smoke: 5, divine: 6 };

/** The motes around a monster, from its Attribute (none for an unknown one). */
export function moteStyleFor(attribute: string | undefined): MoteStyle | null {
  return MOTES[(attribute ?? '').toUpperCase()] ?? null;
}

/** 0 plain, 1 a boss (Level 7+ or 2500+ printed ATK), 2 the duelist's Ace. */
export type Presence = 0 | 1 | 2;
export function presenceOf(level: number | undefined, atk: number | undefined, ace: boolean): Presence {
  if (ace) return 2;
  return (level ?? 0) >= 7 || (atk ?? 0) >= 2500 ? 1 : 0;
}
/** Motes come thicker round a boss, thicker still round an Ace. */
export const presenceMotes = (p: Presence) => (p === 2 ? 1.8 : p === 1 ? 1.4 : 1);

/** Battle-worn: full for WORN_MS after it survived a hit, then it recovers over WORN_FADE_MS. */
export const WORN_MS = 18000;
export const WORN_FADE_MS = 8000;
export function wornAmount(sinceMs: number): number {
  if (!(sinceMs >= 0)) return 0;
  if (sinceMs <= WORN_MS) return 1;
  return Math.max(0, 1 - (sinceMs - WORN_MS) / WORN_FADE_MS);
}

/** A glance at a new arrival: turns toward it, holds, turns back (0..1 envelope over GLANCE_S). */
export const GLANCE_S = 1.8;
export function glanceEnvelope(k: number): number {
  if (k <= 0 || k >= 1) return 0;
  if (k < 0.2) return Math.sin((k / 0.2) * (Math.PI / 2));
  if (k < 0.7) return 1;
  return Math.cos(((k - 0.7) / 0.3) * (Math.PI / 2));
}

/** The idle part of a figure's pose this frame. Every length is a share of the card's width. */
export interface IdlePose {
  /** lift over the card */
  lift: number;
  /** extra scale (breathing): x and y */
  sx: number;
  sy: number;
  /** turn (y), rock (z) and lean forward (+x) in radians */
  turn: number;
  roll: number;
  lean: number;
  /** 0..1 how far it hovers (the base shadow shrinks under it) */
  float: number;
  /** extra darkening (battle-worn) */
  dark: number;
  /** aura pulse 0..1 (presence) */
  aura: number;
}

export interface IdleMood {
  /** an attack or effect is aimed at it now */
  braced: boolean;
  /** 0..1 battle-worn */
  worn: number;
  /** its duelist's LP are in danger */
  tense: boolean;
  /** kneeling (Defense) 0..1: it does not hover, sways less */
  kneel: number;
  presence: Presence;
  /** -1..1 glance (toward an arrival, signed left/right), already enveloped */
  glance: number;
}

export const newIdlePose = (): IdlePose => ({ lift: 0, sx: 1, sy: 1, turn: 0, roll: 0, lean: 0, float: 0, dark: 0, aura: 0 });

/** a cheap deterministic hash in 0..1 */
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/**
 * Writes the idle pose at time `t` (seconds) into `out` (no allocation).
 * `seed` keeps neighbours out of step.
 */
export function idlePoseInto(out: IdlePose, s: IdleStyle, m: IdleMood, t: number, seed: number): IdlePose {
  const ph = seed * 0.37;
  const stand = 1 - m.kneel;
  // tense: quicker, shallower breaths; worn: slow, deep ones
  const bRate = s.breathRate * (m.tense ? 1.7 : 1) * (1 - 0.3 * m.worn);
  const bAmp = (s.breathAmp || (m.worn > 0 ? 0.006 : 0)) * (m.tense ? 0.8 : 1) * (1 + 0.9 * m.worn);
  // a breath: in quicker than out
  const b = Math.sin(t * bRate + ph);
  const breath = (b > 0 ? b : b * 0.7) * bAmp;
  out.sx = 1 + breath * 0.4;
  out.sy = 1 + breath;
  // hover (standing only), bobbing
  const hov = s.hover * stand * (1 - 0.5 * m.worn);
  // (a hovering monster bobs round its hover height; one standing on its card rises off it and back)
  const wave = Math.sin(t * s.bobRate + ph * 1.3);
  const bob = hov > 0 ? s.bobAmp * (1 + wave) : s.bobAmp * 0.3 * (1 + wave);
  out.lift = Math.max(0, hov + bob * stand);
  out.float = s.hover > 0 ? clamp01(out.lift / (s.hover + s.bobAmp * 2)) * stand : 0;
  // turning: smooth, or in servo steps
  let turnT = t * s.swayRate + ph;
  if (s.steps > 0) {
    const q = Math.floor(turnT * s.steps);
    const f = turnT * s.steps - q;
    // ease within each step (a servo snaps then settles)
    turnT = (q + Math.min(1, f * 4)) / s.steps;
  }
  out.turn = Math.sin(turnT) * s.swayAmp * (1 - 0.5 * m.kneel) * (m.braced ? 0.3 : 1) + m.glance * 0.42;
  out.roll = Math.sin(t * s.rollRate + ph * 2.1) * s.rollAmp * (1 - 0.6 * m.kneel);
  // (every motion here stays under ~2 Hz: the settled field draws at 10-20 fps, a faster shiver only strobes)
  if (s.hum > 0) out.roll += Math.sin(t * 9 + ph) * s.hum;
  // a twitch: a quick shudder now and then (Insects, Plants)
  if (s.twitch > 0) {
    const slot = Math.floor(t / 1.7 + ph);
    const f = t / 1.7 + ph - slot;
    if (hash(slot + seed) < 0.35 * s.twitch && f < 0.4) out.roll += Math.sin((f / 0.4) * Math.PI * 2) * 0.05;
  }
  out.lean = 0.1 * m.worn * stand;
  // braced: leans back and shivers while something is aimed at it
  if (m.braced) {
    out.lean -= 0.07;
    out.roll += Math.sin(t * 12 + ph) * 0.022;
    out.turn += Math.sin(t * 9 + ph) * 0.025;
  }
  out.dark = 0.14 * m.worn;
  // aura: a slow swell (a boss), stronger for an Ace
  out.aura = m.presence ? (m.presence === 2 ? 0.55 : 0.35) * (0.5 + 0.5 * Math.sin(t * 1.3 + ph)) : 0;
  return out;
}

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

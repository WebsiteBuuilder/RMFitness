// Entrance jingles: a duelist's 2-3 second personal fanfare, played as a Speed Duel begins (yours
// first, then your opponent's, who hears yours too). Plain data: who can have which, and each
// jingle's score, which src/jingles/play.ts performs with Web Audio (no audio files).

export type JingleId =
  | 'duelist'
  | 'disk'
  | 'challenge'
  | 'dragon'
  | 'magic'
  | 'toon'
  | 'gear'
  | 'pharaoh'
  | 'academy'
  | 'star'
  | 'destiny'
  | 'shadowgame';

/** How a jingle is had (the same routes as sleeves: nothing from Practice, Anything goes decks or money). */
export type JingleCost =
  | { free: true }
  | { chips: number }
  /** reach this Ranked tier (its id) in any season */
  | { ranked: string }
  /** claim this many Set Stamps in all */
  | { stamps: number }
  /** take an Ace to the top bond */
  | { bond: true }
  /** finish Duel School */
  | { school: true };

export type Inst = 'brass' | 'swell' | 'lead' | 'chip' | 'bell' | 'pluck' | 'pad' | 'timp' | 'kick' | 'snare' | 'hat' | 'crash' | 'riser' | 'slide' | 'boom';
/** [beat, instrument, MIDI note(s) (a slide: [from, to]), length in beats, loudness 0..1 (default 1)] */
export type Note = [number, Inst, number | number[], number, number?];

export interface JingleDef {
  id: JingleId;
  name: string;
  blurb: string;
  cost: JingleCost;
  bpm: number;
  score: Note[];
  /** the tile's colour */
  hue: string;
}

const roll = (from: number, to: number, n: number): Note[] => Array.from({ length: n }, (_, i) => [from + ((to - from) * i) / n, 'snare', 0, 0.1, 0.25 + (0.6 * i) / n] as Note);

export const JINGLES: JingleDef[] = [
  {
    id: 'duelist',
    name: "Duelist's Call",
    blurb: 'Two quick horn calls and a big major chord. Every duelist starts with it.',
    cost: { free: true },
    bpm: 132,
    hue: '#ffb04a',
    score: [
      [0, 'brass', [57, 62], 0.45],
      [0.5, 'brass', [57, 62], 0.22],
      [0.75, 'brass', [57, 62], 0.22],
      [1, 'brass', [62, 66, 69], 0.45],
      [1.5, 'brass', [64, 67, 71], 0.45],
      [2, 'brass', [62, 66, 69, 74], 2.2],
      [0, 'timp', 38, 0.5],
      [1, 'timp', 45, 0.5],
      [2, 'timp', 50, 1],
      [2, 'kick', 0, 1],
      [2, 'crash', 0, 2],
    ],
  },
  {
    id: 'disk',
    name: 'Duel Disk Boot',
    blurb: 'Your Duel Disk powers up: a rising beep run and a synth stab.',
    cost: { free: true },
    bpm: 140,
    hue: '#6cc4ff',
    score: [
      ...[60, 63, 67, 72, 75, 79, 84].map((n, i) => [i * 0.25, 'chip', n, 0.22, 0.8] as Note),
      [1.75, 'slide', [48, 72], 0.6],
      [2.5, 'lead', [72, 79], 1.6],
      [2.5, 'pad', [60, 63, 67], 1.6, 0.8],
      [0, 'kick', 0, 1],
      [1, 'kick', 0, 1],
      [2, 'kick', 0, 1],
      [2.5, 'kick', 0, 1],
      [2.5, 'snare', 0, 0.5],
      [2.5, 'crash', 0, 1.5, 0.6],
      ...[0.5, 1, 1.5, 2].map((b) => [b, 'hat', 0, 0.1] as Note),
    ],
  },
  {
    id: 'challenge',
    name: 'The Challenge',
    blurb: 'A low hit, a drum roll, and a minor chord that means business.',
    cost: { free: true },
    bpm: 100,
    hue: '#ff5a5a',
    score: [
      [0, 'boom', 38, 1.5],
      [0, 'brass', [38, 50], 0.9],
      ...roll(0.75, 2, 10),
      [1, 'brass', [57], 0.45],
      [1.5, 'brass', [58], 0.45],
      [2, 'brass', [50, 57, 62, 65], 2],
      [2, 'timp', 38, 1],
      [2, 'crash', 0, 2],
    ],
  },
  {
    id: 'dragon',
    name: "Dragon's Roar",
    blurb: 'Wind, a rising horn and a roar that lands in E major.',
    cost: { chips: 4 },
    bpm: 110,
    hue: '#5fd0ff',
    score: [
      [0, 'riser', 0, 2],
      [0, 'swell', [40, 47, 52], 2],
      [2, 'brass', [52, 56, 59, 64], 2.2],
      [2, 'boom', 40, 1.5],
      [2, 'timp', 40, 1],
      [2, 'crash', 0, 2],
    ],
  },
  {
    id: 'magic',
    name: 'Dark Magic',
    blurb: 'Four bells climbing into the unknown, then a dark spell chord.',
    cost: { chips: 4 },
    bpm: 120,
    hue: '#b36bff',
    score: [
      [0, 'bell', 74, 1],
      [0.5, 'bell', 78, 1],
      [1, 'bell', 82, 1],
      [1.5, 'bell', 86, 1.5],
      [2, 'brass', [50, 53, 57, 61], 2],
      [2, 'pad', [38, 50], 2],
      [2, 'boom', 38, 1.2],
    ],
  },
  {
    id: 'toon',
    name: 'Toon Bounce',
    blurb: 'Bouncy beeps, a boing, and a cheeky major chord.',
    cost: { chips: 4 },
    bpm: 150,
    hue: '#ff9ae8',
    score: [
      [0, 'chip', 72, 0.25],
      [0.5, 'chip', 76, 0.25],
      [1, 'chip', 79, 0.25],
      [1.5, 'chip', 84, 0.25],
      [2, 'slide', [60, 84], 0.5],
      [2.75, 'chip', [72, 76, 79], 0.9],
      [0, 'kick', 0, 0.5, 0.6],
      [1, 'snare', 0, 0.3, 0.5],
      [2.75, 'kick', 0, 0.5, 0.7],
      [2.75, 'hat', 0, 0.2],
    ],
  },
  {
    id: 'gear',
    name: 'Steel Gear',
    blurb: 'Pounding drums and a machine riff, for decks that grind.',
    cost: { chips: 6 },
    bpm: 128,
    hue: '#3ae0ff',
    score: [
      ...[40, 40, 52, 40, 43, 40, 47, 45].map((n, i) => [i * 0.25, 'chip', n, 0.2, 0.9] as Note),
      ...[0, 1, 2, 3].map((b) => [b, 'kick', 0, 0.5] as Note),
      [1, 'snare', 0, 0.3],
      [2, 'brass', [52, 59, 64], 0.9],
      [3, 'brass', [55, 62, 67], 1.3],
      [2, 'snare', 0, 0.3],
      [3, 'snare', 0, 0.3],
      [3, 'crash', 0, 1.6],
    ],
  },
  {
    id: 'pharaoh',
    name: "Pharaoh's Herald",
    blurb: 'A desert trumpet call. For duelists who reached Gold in Ranked.',
    cost: { ranked: 'gold' },
    bpm: 112,
    hue: '#f6dc96',
    score: [
      [0, 'brass', [62], 0.45],
      [0.5, 'brass', [63], 0.45],
      [1, 'brass', [66], 0.45],
      [1.5, 'brass', [67], 0.45],
      [2, 'brass', [62, 66, 69, 74], 2],
      [0, 'timp', 38, 0.8],
      [2, 'timp', 38, 1],
      [2, 'crash', 0, 2],
    ],
  },
  {
    id: 'academy',
    name: 'Academy Bell',
    blurb: 'A school bell rings you into the duel. For Duel School graduates.',
    cost: { school: true },
    bpm: 96,
    hue: '#ffe27a',
    score: [
      [0, 'bell', 76, 1],
      [0.5, 'bell', 79, 1],
      [1, 'bell', 84, 1],
      [1.5, 'bell', 83, 1],
      [2, 'bell', [72, 76, 79], 2],
      [2, 'pad', [48, 55, 64], 2],
    ],
  },
  {
    id: 'star',
    name: 'Starfall',
    blurb: 'A shower of sparkles settling into a warm chord. From Set Stamps.',
    cost: { stamps: 6 },
    bpm: 130,
    hue: '#bcd0ff',
    score: [
      ...[96, 91, 88, 84, 79, 76, 72].map((n, i) => [i * 0.25, 'bell', n, 1, 0.7] as Note),
      [2, 'pad', [60, 64, 67, 71], 2.2],
      [2, 'swell', [48, 55], 1.6, 0.6],
    ],
  },
  {
    id: 'destiny',
    name: 'Heart of the Cards',
    blurb: 'A short, hopeful theme. Earned by taking an Ace to its top bond.',
    cost: { bond: true },
    bpm: 90,
    hue: '#ffb04a',
    score: [
      [0, 'pad', [50, 57, 62, 66], 4],
      [0, 'lead', 69, 0.7],
      [0.75, 'lead', 71, 0.25],
      [1, 'lead', 74, 1],
      [2, 'lead', 73, 0.5],
      [2.5, 'lead', 74, 1.5],
      [2, 'timp', 50, 1],
    ],
  },
  {
    id: 'shadowgame',
    name: 'Shadow Game',
    blurb: 'A drone, a wrong-sounding bell, and dread. For Duel King and above.',
    cost: { ranked: 'king' },
    bpm: 84,
    hue: '#c070ff',
    score: [
      [0, 'pad', [38, 50], 4],
      [0, 'bell', 80, 1.5],
      [1, 'brass', [44, 50], 0.9],
      [2, 'brass', [38, 44, 50, 56], 2],
      [2, 'boom', 38, 1.5],
      [2, 'crash', 0, 2, 0.6],
    ],
  },
];

const BY_ID = new Map(JINGLES.map((j) => [j.id, j]));
export const jingleDef = (id: string | null | undefined): JingleDef | undefined => (id ? BY_ID.get(id as JingleId) : undefined);
export const isJingle = (id: unknown): id is JingleId => typeof id === 'string' && BY_ID.has(id as JingleId);
export const DEFAULT_JINGLE: JingleId = 'duelist';

/** How long a jingle runs, in seconds (its last note's end plus the ring-out). */
export function jingleLength(d: JingleDef): number {
  const end = Math.max(...d.score.map(([b, , , len]) => b + len));
  return (end * 60) / d.bpm + 0.5;
}

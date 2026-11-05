// The sleeve roster: plain data (no economy, no screens), so the duel's card backs can read it cheaply.
import { SLEEVE_SVG, type SleeveId } from './art';

export type { SleeveId } from './art';

/** How a sleeve is had. */
export type SleeveCost =
  | { free: true }
  | { chips: number }
  /** reach this Ranked tier (its id) in any season */
  | { ranked: string }
  /** claim this many Set Stamps in all */
  | { stamps: number }
  /** take an Ace to the top bond */
  | { bond: true }
  /** finish Duel School */
  | { school: true }
  /** a Duel Pass reward (src/pass): never sold, only reached on the pass */
  | { pass: true };

export interface SleeveDef {
  id: SleeveId;
  name: string;
  blurb: string;
  cost: SleeveCost;
  /** a light that runs over it on the deck pile and in the picker (none on hands and Set cards: they stay still) */
  shine?: 'sweep' | 'holo' | 'pulse';
  /** the colour its deck pile glows */
  glow: string;
}

export const SLEEVES: SleeveDef[] = [
  { id: 'vortex', name: 'Classic Vortex', blurb: 'The old gold-rimmed vortex. Every duelist starts with it.', cost: { free: true }, glow: '#ffb04a' },
  { id: 'duelist', name: 'Duelist Blue', blurb: 'A silver compass star on tournament blue.', cost: { free: true }, glow: '#6cc4ff' },
  { id: 'crimson', name: 'Crimson Crest', blurb: 'A ruby set in gold on deep red pinstripes.', cost: { free: true }, glow: '#ff5a5a' },
  { id: 'shadow', name: 'Night Shadow', blurb: 'A violet star in the dark. Quiet, and a little menacing.', cost: { free: true }, glow: '#a77bff' },
  { id: 'light', name: 'LIGHT', blurb: 'A sunburst of white gold.', cost: { chips: 3 }, glow: '#fff2b0' },
  { id: 'dark', name: 'DARK', blurb: 'A black moon in purple orbits.', cost: { chips: 3 }, glow: '#b36bff' },
  { id: 'fire', name: 'FIRE', blurb: 'The bottom of the card is on fire. On purpose.', cost: { chips: 4 }, glow: '#ff7a1a' },
  { id: 'water', name: 'WATER', blurb: 'A drop over rolling tide lines.', cost: { chips: 4 }, glow: '#5fd0ff' },
  { id: 'earth', name: 'EARTH', blurb: 'A mountain carved in hexagon stone.', cost: { chips: 4 }, glow: '#c8a060' },
  { id: 'wind', name: 'WIND', blurb: 'A green whirl and drifting leaves.', cost: { chips: 4 }, glow: '#7ad8a4' },
  { id: 'chrome', name: 'Chrome Circuit', blurb: 'Brushed metal with a cyan core. Runs a light over it.', cost: { chips: 8 }, shine: 'sweep', glow: '#3ae0ff' },
  { id: 'gold', name: 'Solid Gold', blurb: 'Polished gold with a ruby. Shines on your deck.', cost: { chips: 12 }, shine: 'sweep', glow: '#ffd04a' },
  { id: 'academy', name: 'Duel Academy', blurb: 'Your Duel School graduation crest.', cost: { school: true }, glow: '#ffe27a' },
  { id: 'wdjat', name: 'Millennium Puzzle', blurb: 'The Eye of Wdjat.', cost: { ranked: 'gold' }, shine: 'sweep', glow: '#f6dc96' },
  { id: 'shadowrealm', name: 'Shadow Realm', blurb: 'Something watches from the fog.', cost: { ranked: 'king' }, shine: 'pulse', glow: '#c070ff' },
  { id: 'pharaoh', name: 'Pharaoh’s Tomb', blurb: 'The ankh in a royal cartouche.', cost: { ranked: 'pharaoh' }, shine: 'sweep', glow: '#ffd56a' },
  { id: 'starlight', name: 'Starlight', blurb: 'A dragon drawn in stars.', cost: { stamps: 6 }, shine: 'pulse', glow: '#bcd0ff' },
  { id: 'holo', name: 'Holo Prism', blurb: 'A full rainbow foil that shifts as it catches the light.', cost: { stamps: 15 }, shine: 'holo', glow: '#ff9ae8' },
  { id: 'seasoncrest', name: 'Season Crest', blurb: 'A silver shield in laurels. Duel Pass, free lane.', cost: { pass: true }, glow: '#cfe0ff' },
  { id: 'pyramid', name: 'Pyramid of Light', blurb: 'A golden pyramid that watches back. Duel Pass, Chips lane.', cost: { pass: true }, shine: 'pulse', glow: '#ffe9a0' },
  { id: 'dragonflare', name: 'Dragon Flare', blurb: 'Black wings over a rising flame. Duel Pass, Chips lane.', cost: { pass: true }, shine: 'sweep', glow: '#ff7a3a' },
  { id: 'champion', name: 'Pass Champion', blurb: 'A gold crown on prism foil: the top of the Duel Pass.', cost: { pass: true }, shine: 'holo', glow: '#fff2c0' },
  { id: 'soul', name: 'Heart of the Cards', blurb: 'Believe in your deck.', cost: { bond: true }, shine: 'pulse', glow: '#ffb04a' },
];

const BY_ID = new Map(SLEEVES.map((s) => [s.id, s]));
export const sleeveDef = (id: string | null | undefined): SleeveDef | undefined => (id ? BY_ID.get(id as SleeveId) : undefined);
export const isSleeve = (id: unknown): id is SleeveId => typeof id === 'string' && BY_ID.has(id as SleeveId) && id in SLEEVE_SVG;
export const DEFAULT_SLEEVE: SleeveId = 'vortex';


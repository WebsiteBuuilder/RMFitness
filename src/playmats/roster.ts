// The playmat roster: plain data (no economy, no screens), so the duel screen can read it cheaply.
import { PLAYMAT_SVG, type MatFx, type PlaymatId } from './art';
import type { SleeveCost } from '../sleeves/roster';

export type { PlaymatId, MatFx } from './art';

/** How a mat is had: the same ways as sleeves (free, Duel Chips, Ranked, Set Stamps, Ace bond, Duel School). */
export type PlaymatCost = SleeveCost;

export interface PlaymatDef {
  id: PlaymatId;
  name: string;
  blurb: string;
  cost: PlaymatCost;
  /** its ambient motion (one layer a half, transform/opacity only) */
  fx: MatFx;
  /** the colour of that motion */
  fxColor: string;
  /** the zone frames' colour on this mat */
  line: string;
  /** the mat's accent (its glow in the picker and on the Duelist tab) */
  glow: string;
  /** a light mat: the zones get a darker backing so cards and frames still read */
  bright?: boolean;
}

export const PLAYMATS: PlaymatDef[] = [
  { id: 'blue', name: 'Tournament Blue', blurb: 'The classic duel ring in silver on deep blue.', cost: { free: true }, fx: 'sweep', fxColor: '#cfe0ff', line: '#cfe0ff', glow: '#6c94ff' },
  { id: 'crimson', name: 'Crimson Arena', blurb: 'A gold eight-point star on red stone.', cost: { free: true }, fx: 'motes', fxColor: '#ffd27a', line: '#f6dc96', glow: '#ff5a5a' },
  { id: 'kingdom', name: 'Duelist Kingdom', blurb: 'The island at sunset, the castle on its cliff.', cost: { free: true }, fx: 'sparkle', fxColor: '#ffe2b0', line: '#ffe2b0', glow: '#ffb36a' },
  { id: 'disk', name: 'Duel Disk Grid', blurb: 'Hex glass and circuits running into a cyan core.', cost: { free: true }, fx: 'scan', fxColor: '#3ae0ff', line: '#9ff2ff', glow: '#3ae0ff' },
  { id: 'light', name: 'LIGHT Temple', blurb: 'A sky temple: columns of white gold and a gate of light.', cost: { chips: 4 }, fx: 'sparkle', fxColor: '#ffffff', line: '#fff6d0', glow: '#fff2b0', bright: true },
  { id: 'dark', name: 'DARK Chapel', blurb: 'A ruined chapel under an eclipse, violet mist on the stones.', cost: { chips: 4 }, fx: 'fog', fxColor: '#b36bff', line: '#d6b8ff', glow: '#b36bff' },
  { id: 'fire', name: 'FIRE Volcano', blurb: 'A volcanic field: lava in the cracks, embers rising.', cost: { chips: 5 }, fx: 'embers', fxColor: '#ffb04a', line: '#ffd27a', glow: '#ff7a1a' },
  { id: 'water', name: 'WATER Depths', blurb: 'The sea floor: light from the surface, kelp and bubbles.', cost: { chips: 5 }, fx: 'bubbles', fxColor: '#cff0ff', line: '#cff0ff', glow: '#5fd0ff' },
  { id: 'earth', name: 'EARTH Canyon', blurb: 'A canyon floor between walls of layered rock.', cost: { chips: 5 }, fx: 'motes', fxColor: '#f2d8a8', line: '#f2d8a8', glow: '#c8a060' },
  { id: 'wind', name: 'WIND Skyreach', blurb: 'A stone platform above the clouds, leaves on the wind.', cost: { chips: 5 }, fx: 'leaves', fxColor: '#b8f2d0', line: '#e6fff2', glow: '#7ad8a4' },
  { id: 'city', name: 'Battle City Rooftop', blurb: 'A helipad at night, the whole skyline lit up.', cost: { chips: 8 }, fx: 'stars', fxColor: '#ffffff', line: '#e0d0ff', glow: '#ff7ac0' },
  { id: 'castle', name: 'Pegasus Castle', blurb: 'The great hall: rose window, marble, red carpet.', cost: { chips: 10 }, fx: 'sweep', fxColor: '#ffe2f4', line: '#f6dc96', glow: '#ff9ae8' },
  { id: 'dome', name: 'Kaiba Dome', blurb: 'A stadium in the dark, spotlights on the floor.', cost: { chips: 12 }, fx: 'scan', fxColor: '#cfe6ff', line: '#cfe6ff', glow: '#6cc4ff' },
  { id: 'academy', name: 'Duel Academy', blurb: 'The island school and its crest. For graduates.', cost: { school: true }, fx: 'sparkle', fxColor: '#ffe27a', line: '#ffe9a8', glow: '#ffe27a', bright: true },
  { id: 'starfall', name: 'Starfall', blurb: 'A dragon drawn in stars over the observatory.', cost: { stamps: 4 }, fx: 'stars', fxColor: '#ffffff', line: '#d8e2ff', glow: '#bcd0ff' },
  { id: 'millennium', name: 'Millennium Stone', blurb: 'The tablet with the seven items’ places.', cost: { ranked: 'gold' }, fx: 'sweep', fxColor: '#fff2c0', line: '#fbe7a8', glow: '#f6dc96', bright: true },
  { id: 'shadowrealm', name: 'Shadow Realm', blurb: 'Fog, broken stone, and something watching.', cost: { ranked: 'king' }, fx: 'fog', fxColor: '#c070ff', line: '#e0a0ff', glow: '#c070ff' },
  { id: 'tomb', name: 'Pharaoh’s Tomb', blurb: 'Torchlit gold, wall paintings, the winged ankh.', cost: { ranked: 'pharaoh' }, fx: 'embers', fxColor: '#ffcf6a', line: '#fbe7a8', glow: '#ffd56a' },
  { id: 'holo', name: 'Holo Arena', blurb: 'Rainbow foil that shifts under the cards.', cost: { stamps: 10 }, fx: 'holo', fxColor: '#ffffff', line: '#ffffff', glow: '#ff9ae8' },
  { id: 'summit', name: 'Duel Tower Summit', blurb: 'The top of the finals tower at night, searchlights in the clouds. Duel Pass.', cost: { pass: true }, fx: 'stars', fxColor: '#ffffff', line: '#d8e6ff', glow: '#7ab0ff' },
  { id: 'champion', name: 'Champion’s Stage', blurb: 'A gold arena, spotlights and confetti: the top of the Duel Pass.', cost: { pass: true }, fx: 'sparkle', fxColor: '#ffe08a', line: '#fff0b0', glow: '#ffd56a' },
  { id: 'heart', name: 'Heart of the Cards', blurb: 'Five cards round a heart of light.', cost: { bond: true }, fx: 'motes', fxColor: '#fff6d0', line: '#ffe2b0', glow: '#ffb04a' },
];

const BY_ID = new Map(PLAYMATS.map((m) => [m.id, m]));
export const playmatDef = (id: string | null | undefined): PlaymatDef | undefined => (id ? BY_ID.get(id as PlaymatId) : undefined);
export const isPlaymat = (id: unknown): id is PlaymatId => typeof id === 'string' && BY_ID.has(id as PlaymatId) && id in PLAYMAT_SVG;
export const DEFAULT_PLAYMAT: PlaymatId = 'blue';

// The 3D art engine's per-card design. Every card gets its own presentation,
// worked out from the card itself: its name (a seed for every random choice),
// attribute, type, level, stats and kind. The artwork adds its own colors and
// depth at runtime (see depth.ts). Iconic cards get hand-tuned signatures on top.
import type { CardInfo } from '../eds/types';

export type Element = 'FIRE' | 'WATER' | 'WIND' | 'EARTH' | 'LIGHT' | 'DARK' | 'DIVINE';
export type AttackStyle = 'beam' | 'barrage' | 'slash' | 'claw' | 'lightning' | 'flame' | 'torrent' | 'shadow' | 'quake' | 'swarm' | 'gale' | 'ram';
export type Entrance = 'rise' | 'descend' | 'erupt' | 'materialize' | 'portal' | 'splash' | 'fusion' | 'ritual';

export interface ArtProfile {
  name: string;
  seed: number;
  kind: CardInfo['kind'];
  element: Element;
  /** main color of the element, then two accents (replaced by the art's own colors once loaded) */
  colors: [number, number, number];
  style: AttackStyle;
  /** a second style mixed into the attack for some cards */
  style2: AttackStyle | null;
  entrance: Entrance;
  attackName: string;
  /** 0 small … 3 boss: how grand the summon and attack are */
  tier: number;
  // per-card tuning, all 0..1 unless noted
  count: number; // projectiles / slashes / bolts (1..7)
  speed: number;
  arc: number; // how high projectiles curve
  spin: number;
  spread: number;
  width: number; // beam / ribbon thickness
  depth: number; // how far the figure pops out of its art
  camYaw: number; // -1..1 camera swing during the cinematic
  camPitch: number;
  shake: number;
  sway: number; // idle bobbing of the figure
  glyphs: number; // pattern of the summoning circle (seeded)
  hue: number; // -1..1 small shift applied to the element color
}

/** FNV-1a: a stable 32-bit number from a string. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small seeded random stream (mulberry32). */
export function rand(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const ELEMENT_COLORS: Record<Element, [number, number, number]> = {
  FIRE: [0xff5a1f, 0xffc04a, 0xff2a2a],
  WATER: [0x2aa7ff, 0x7fe6ff, 0x1a4dff],
  WIND: [0x55f0a0, 0xd9ffe9, 0x2fc6b0],
  EARTH: [0xc98a3c, 0xffd28a, 0x7a4a1c],
  LIGHT: [0xfff1a8, 0xffffff, 0xffc94a],
  DARK: [0x9a3cff, 0xff4fd8, 0x2a0a5a],
  DIVINE: [0xffd700, 0xfff6c0, 0xff9a00],
};
export const SPELL_COLOR = 0x1fd39a;
export const TRAP_COLOR = 0xe0379a;

const RACE_STYLE: Record<string, AttackStyle> = {
  Dragon: 'beam',
  'Sea Serpent': 'torrent',
  Machine: 'beam',
  Cyberse: 'barrage',
  Spellcaster: 'barrage',
  Fairy: 'barrage',
  Psychic: 'barrage',
  Warrior: 'slash',
  'Beast-Warrior': 'slash',
  Beast: 'claw',
  Dinosaur: 'quake',
  Reptile: 'claw',
  'Winged Beast': 'gale',
  Thunder: 'lightning',
  Pyro: 'flame',
  Aqua: 'torrent',
  Fish: 'torrent',
  Fiend: 'shadow',
  Zombie: 'shadow',
  Rock: 'quake',
  Wyrm: 'gale',
  Insect: 'swarm',
  Plant: 'swarm',
  'Divine-Beast': 'beam',
};

const RACE_ENTRANCE: Record<string, Entrance> = {
  'Winged Beast': 'descend',
  Fairy: 'descend',
  Rock: 'erupt',
  Dinosaur: 'erupt',
  Zombie: 'erupt',
  Plant: 'erupt',
  Insect: 'erupt',
  Spellcaster: 'materialize',
  Psychic: 'materialize',
  Machine: 'materialize',
  Cyberse: 'materialize',
  Thunder: 'materialize',
  Fiend: 'portal',
  Aqua: 'splash',
  Fish: 'splash',
  'Sea Serpent': 'splash',
};

const ADJ: Record<Element, string[]> = {
  FIRE: ['Inferno', 'Blazing', 'Crimson', 'Scorching', 'Molten', 'Ember', 'Searing', 'Volcanic'],
  WATER: ['Tidal', 'Abyssal', 'Torrent', 'Frost', 'Riptide', 'Deep Sea', 'Glacial', 'Cascade'],
  WIND: ['Cyclone', 'Tempest', 'Gale', 'Sky', 'Whirlwind', 'Storm', 'Zephyr', 'Hurricane'],
  EARTH: ['Titan', 'Quake', 'Granite', 'Iron', 'Terra', 'Avalanche', 'Bedrock', 'Thunderous'],
  LIGHT: ['Radiant', 'Holy', 'Shining', 'Celestial', 'Dawn', 'Prism', 'Halo', 'Solar'],
  DARK: ['Shadow', 'Eclipse', 'Phantom', 'Void', 'Midnight', 'Nightmare', 'Abyss', 'Cursed'],
  DIVINE: ['Divine', 'Heavenly', 'Sacred', 'Eternal', 'Almighty', 'Godly', 'Genesis', 'Sovereign'],
};
const NOUN: Record<AttackStyle, string[]> = {
  beam: ['Burst', 'Cannon', 'Breath', 'Ray', 'Blaster', 'Annihilator'],
  barrage: ['Orb Barrage', 'Magic Volley', 'Star Shower', 'Spell Storm', 'Comet Rain', 'Sigil Burst'],
  slash: ['Slash', 'Blade', 'Edge', 'Cleaver', 'Sword Dance', 'Crescent Cut'],
  claw: ['Fang', 'Claw', 'Rending Strike', 'Maul', 'Pounce', 'Talon Rush'],
  lightning: ['Thunderbolt', 'Lightning Strike', 'Spark', 'Thunder Lance', 'Storm Bolt', 'Volt Crash'],
  flame: ['Fireball', 'Flame Bomb', 'Meteor', 'Blaze Shot', 'Fire Storm', 'Hellfire'],
  torrent: ['Torrent', 'Tidal Wave', 'Water Cannon', 'Maelstrom', 'Geyser', 'Hydro Lance'],
  shadow: ['Grasp', 'Curse', 'Soul Drain', 'Dark Tendrils', 'Night Bind', 'Hex'],
  quake: ['Quake', 'Rockfall', 'Stomp', 'Fissure', 'Landslide', 'Crusher'],
  swarm: ['Swarm', 'Spore Storm', 'Vine Lash', 'Hive Rush', 'Thorn Rain', 'Blight'],
  gale: ['Gale', 'Feather Storm', 'Sky Dive', 'Tornado', 'Wing Cutter', 'Air Raid'],
  ram: ['Rush', 'Charge', 'Impact', 'Crash', 'Breaker', 'Full Throttle'],
};

/** Hand-tuned signatures for iconic monsters (everything else comes from the generator). */
const SIGNATURES: Record<string, Partial<ArtProfile>> = {
  'Blue-Eyes White Dragon': { attackName: 'Burst Stream of Destruction', style: 'beam', style2: null, colors: [0x9fdcff, 0xffffff, 0x3f8cff], width: 1, entrance: 'descend', tier: 3 },
  'Blue-Eyes Ultimate Dragon': { attackName: 'Neutron Blast', style: 'beam', style2: 'beam', colors: [0x9fdcff, 0xffffff, 0x3f8cff], width: 1, count: 3, entrance: 'fusion', tier: 3 },
  'Blue-Eyes Alternative White Dragon': { attackName: 'Burst Stream of Destruction', style: 'beam', colors: [0xbfe8ff, 0xffffff, 0x5fa0ff], width: 1, tier: 3 },
  'Dark Magician': { attackName: 'Dark Magic Attack', style: 'barrage', style2: 'beam', colors: [0x8a3cff, 0xff4fd8, 0x2a0a5a], count: 1, entrance: 'materialize', tier: 3 },
  'Dark Magician Girl': { attackName: 'Dark Burning Attack', style: 'barrage', style2: null, colors: [0xff6ad5, 0xffd1f2, 0x8a3cff], count: 5, entrance: 'materialize', tier: 2 },
  'Red-Eyes Black Dragon': { attackName: 'Inferno Fire Blast', style: 'flame', style2: null, colors: [0xff3a1a, 0xffb347, 0x3a0a0a], count: 1, entrance: 'descend', tier: 3 },
  'Red-Eyes Black Metal Dragon': { attackName: 'Metal Fire Ball', style: 'flame', colors: [0xff4a1a, 0xc0c8d8, 0x3a0a0a], tier: 3 },
  'Summoned Skull': { attackName: 'Lightning Strike', style: 'lightning', style2: null, colors: [0xb07aff, 0xfff27a, 0x3a0a5a], count: 4, entrance: 'portal', tier: 3 },
  'Gaia The Fierce Knight': { attackName: 'Spiral Spear Strike', style: 'slash', style2: 'ram', tier: 3 },
  'Black Luster Soldier': { attackName: 'Chaos Blade', style: 'slash', colors: [0x3f6bff, 0xffd84a, 0x1a1a3a], count: 3, entrance: 'ritual', tier: 3 },
  'Jinzo': { attackName: 'Cyber Energy Shock', style: 'lightning', style2: 'barrage', colors: [0x7a2aff, 0x9affff, 0x1a0a3a], tier: 2 },
  'Harpie Lady Sisters': { attackName: 'Triangle Ecstasy Spark', style: 'lightning', style2: 'gale', count: 3, tier: 2 },
  'Exodia the Forbidden One': { attackName: 'Exodia Obliterate', style: 'beam', colors: [0xffc94a, 0xfff6c0, 0xff7a00], tier: 3 },
  'Exodia Necross': { attackName: 'Exodia Obliterate', style: 'beam', colors: [0x9a3cff, 0xffc94a, 0x1a0a2a], tier: 3 },
  'Cyber End Dragon': { attackName: 'Eternal Evolution Burst', style: 'beam', style2: 'beam', count: 3, colors: [0xd0e8ff, 0x7affff, 0x3a6aff], entrance: 'fusion', tier: 3 },
  'Cyber Dragon': { attackName: 'Evolution Burst', style: 'beam', colors: [0xd0e8ff, 0x7affff, 0x3a6aff], tier: 2 },
  'Elemental HERO Flame Wingman': { attackName: 'Skydive Scorcher', style: 'flame', style2: 'gale', tier: 3 },
  'Elemental HERO Neos': { attackName: 'Wrath of Neos', style: 'slash', style2: 'ram', colors: [0xffffff, 0x4ad8ff, 0xff3a3a], tier: 3 },
  'Kuriboh': { attackName: 'Kuri Kuri!', style: 'ram', style2: null, tier: 0 },
  'Time Wizard': { attackName: 'Time Magic', style: 'barrage', tier: 1 },
  'Buster Blader': { attackName: 'Dragon Destroyer Sword', style: 'slash', count: 2, tier: 3 },
  'Flame Swordsman': { attackName: 'Salamandra Slash', style: 'slash', style2: 'flame', tier: 2 },
  'Celtic Guardian': { attackName: 'Elf Sword Slash', style: 'slash', tier: 1 },
  'Thousand Dragon': { attackName: 'Noxious Vapor', style: 'gale', colors: [0xb8a8ff, 0xffffff, 0x6a5aa0], tier: 3 },
  'Dark Paladin': { attackName: 'Dark Magic Blade', style: 'slash', style2: 'barrage', colors: [0x6a2aff, 0xff4fd8, 0x10103a], entrance: 'fusion', tier: 3 },
  'Black Skull Dragon': { attackName: 'Molten Fire Ball', style: 'flame', style2: 'lightning', entrance: 'fusion', tier: 3 },
};

const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The full art profile for one card. Pure: the same card always gets the same profile. */
export function profileFor(info: CardInfo | undefined, name: string): ArtProfile {
  const seed = hash(name || 'unknown');
  const r = rand(seed);
  const kind = info?.kind ?? 'monster';
  const attr = (info?.attribute ?? '').toUpperCase();
  const element: Element = (['FIRE', 'WATER', 'WIND', 'EARTH', 'LIGHT', 'DARK', 'DIVINE'] as Element[]).includes(attr as Element) ? (attr as Element) : kind === 'trap' ? 'DARK' : kind === 'spell' ? 'WIND' : 'LIGHT';
  const race = info?.race ?? '';
  const level = info?.level ?? 4;
  const atk = info?.atk ?? 0;
  const sub = info?.sub ?? 'Normal';
  const styles = Object.keys(NOUN) as AttackStyle[];
  let style: AttackStyle = RACE_STYLE[race] ?? styles[Math.floor(r() * styles.length)];
  // Big machines charge in; small beasts sometimes swipe with their element instead.
  if (race === 'Machine' && r() < 0.35) style = 'ram';
  if (element === 'FIRE' && r() < 0.25 && style !== 'beam') style = 'flame';
  if (element === 'WATER' && r() < 0.2) style = 'torrent';
  const style2 = r() < 0.35 ? styles[Math.floor(r() * styles.length)] : null;
  let entrance: Entrance = RACE_ENTRANCE[race] ?? (element === 'DARK' && r() < 0.5 ? 'portal' : 'rise');
  if (race === 'Dragon' && level >= 7) entrance = 'descend';
  if (sub === 'Fusion') entrance = 'fusion';
  if (sub === 'Ritual') entrance = 'ritual';
  const tier = kind !== 'monster' ? 1 : level >= 8 || atk >= 2800 ? 3 : level >= 5 || atk >= 2000 ? 2 : level >= 3 ? 1 : 0;
  const adj = ADJ[element][Math.floor(r() * ADJ[element].length)];
  const noun = NOUN[style][Math.floor(r() * NOUN[style].length)];
  // Some cards lend their own first word to the attack ("Celtic Radiant Slash").
  const word = name.split(/[\s-]+/).find((w) => w.length > 3 && !/^(the|of|and|with|from)$/i.test(w));
  const attackName = word && r() < 0.4 ? `${word.replace(/[^A-Za-z']/g, '')} ${adj} ${noun}` : `${adj} ${noun}`;
  const base: ArtProfile = {
    name,
    seed,
    kind,
    element,
    colors: kind === 'spell' ? [SPELL_COLOR, 0xc8ffe8, 0x0a8a6a] : kind === 'trap' ? [TRAP_COLOR, 0xffc8ec, 0x6a0a4a] : ELEMENT_COLORS[element],
    style,
    style2: style2 === style ? null : style2,
    entrance,
    attackName,
    tier,
    count: 1 + Math.floor(r() * 3 + tier * 1.2),
    speed: 0.35 + r() * 0.65,
    arc: r(),
    spin: r(),
    spread: r(),
    width: clamp01(0.3 + r() * 0.5 + tier * 0.1),
    depth: 0.45 + r() * 0.45,
    camYaw: r() * 2 - 1,
    camPitch: r(),
    shake: clamp01(0.25 + tier * 0.22 + r() * 0.2),
    sway: r(),
    glyphs: Math.floor(r() * 1e9),
    hue: r() * 2 - 1,
  };
  return { ...base, ...(SIGNATURES[name] ?? {}) };
}

export const SIGNATURE_CARDS = Object.keys(SIGNATURES);

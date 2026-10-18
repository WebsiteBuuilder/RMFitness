// Hand-tuned figure settings for the iconic monsters, applied wherever their
// figure stands: the cinematics (through the Figure constructor and figureFoot())
// and the field (board.ts). Everything is optional; a card that is not listed
// gets the automatic look (stage.ts measures the art's brightness and saturation
// and tames the lighting on white / chrome subjects by itself).
//
// Keys are card ids (public/cards/speed.json).

export interface FigureTune {
  /** subject size multiplier, about the feet (cinematics and field); 1 = as measured */
  scale?: number;
  /** override the measured foot point, in art uv (0..1, v up) */
  footU?: number;
  footV?: number;
  /** relief depth multiplier (lower = flatter, keeps a painted look on busy art) */
  relief?: number;
  /** specular and rim multipliers (0..1), on top of the automatic taming */
  spec?: number;
  rim?: number;
  /** extra lighting taming 0..1 (white, silver, chrome subjects keep their texture) */
  tame?: number;
  /** width of the soft, broken fade at the art's border (uv); default 0.08. Wider for subjects cut by the frame */
  fade?: number;
}

export const DEFAULT_FADE = 0.08;

export const FIGURE_TUNES: Record<number, FigureTune> = {
  // Dark Magician: robe fills the bottom edge, staff crosses the frame. Flatter: seen over the
  // shoulder as an attacker, deeper relief smeared the purple robe and face sideways
  46986414: { relief: 0.6, fade: 0.11, rim: 0.8 },
  // Blue-Eyes White Dragon: white chrome scales, wing cut by the right edge. Near-flat: a parallax
  // billboard keeps the painted head, coiled body and tail reading as a dragon (any real relief turns the coil into a C-shaped slab)
  89631139: { tame: 0.75, relief: 0.2, fade: 0.12, spec: 0.5, rim: 0.9, scale: 1.2 },
  // Red-Eyes Black Dragon: dark metal; wings run off both sides
  74677422: { tame: 0.35, relief: 0.85, fade: 0.13, rim: 0.8 },
  // Summoned Skull: silver bone over purple flesh, fills the whole art
  70781052: { tame: 0.85, relief: 0.7, fade: 0.15, spec: 0.35, rim: 0.45 },
  // Kuriboh: a round fur ball, more body
  40640057: { relief: 1.1, scale: 0.9, fade: 0.08 },
  // Celtic Guardian: half-length figure, arms cut by the frame
  91152256: { relief: 0.85, fade: 0.15 },
  // Cyber Dragon: polished silver coils
  70095154: { tame: 0.85, relief: 0.75, fade: 0.11, spec: 0.4, rim: 0.5 },
  // Blue-Eyes Ultimate Dragon: three heads, the top one at the art edge; near-flat like Blue-Eyes
  23995346: { tame: 0.7, relief: 0.35, fade: 0.08, spec: 0.45, rim: 0.9, scale: 1.2 },
  // Gaia The Fierce Knight: lance and horse run off the frame
  6368038: { relief: 0.85, fade: 0.13 },
  // Jinzo: cut at the waist
  77585513: { relief: 0.9, fade: 0.12, tame: 0.2 },
  // Harpie Lady 1
  91932350: { relief: 0.9, fade: 0.1 },
  // Harpie Lady Sisters: three busts filling the frame
  12206212: { relief: 0.75, fade: 0.17 },
  // Dark Magician Girl: bust, hat cut at the top
  38033121: { relief: 0.8, fade: 0.15, rim: 0.7 },
  // Buster Blader: huge sword across the frame, silver armour
  78193831: { tame: 0.45, relief: 0.8, fade: 0.14 },
  // Black Luster Soldier
  5405694: { tame: 0.3, relief: 0.85, fade: 0.1 },
  // Time Wizard
  71625222: { relief: 1.0, fade: 0.09, scale: 0.95 },
  // Baby Dragon
  88819587: { relief: 1.05, fade: 0.09, scale: 0.92 },
  // Thousand Dragon: wide wings at the top corners
  41462083: { relief: 0.85, fade: 0.14 },
  // Alligator's Sword
  64428736: { relief: 0.9, fade: 0.12 },
  // Flame Swordsman: blade cut by the right edge
  45231177: { relief: 0.8, fade: 0.15, tame: 0.2 },
  // Curse of Dragon
  28279543: { relief: 0.9, fade: 0.12 },
  // Gaia the Dragon Champion
  66889139: { relief: 0.85, fade: 0.13 },
  // Beta / Alpha / Gamma The Magnet Warrior
  39256679: { relief: 0.95, fade: 0.1, tame: 0.2 },
  99785935: { relief: 0.8, fade: 0.15, tame: 0.5 },
  11549357: { relief: 0.9, fade: 0.12, tame: 0.35 },
  // Valkyrion the Magna Warrior
  75347539: { relief: 0.85, fade: 0.13, tame: 0.45 },
  // Mystical Elf: pale blue skin, gold
  15025844: { relief: 0.85, fade: 0.13, tame: 0.35 },
  // Giant Soldier of Stone: grey stone
  13039848: { relief: 0.8, fade: 0.14, tame: 0.65, spec: 0.3 },
  // Sanga of the Thunder
  25955164: { relief: 0.85, fade: 0.15 },
  // Feral Imp
  41392891: { relief: 0.95, fade: 0.1 },
  // La Jinn the Mystical Genie of the Lamp
  97590747: { relief: 0.85, fade: 0.14 },
  // Man-Eater Bug
  54652250: { relief: 0.95, fade: 0.1 },
  // Big Shield Gardna: a wall of shield
  65240384: { relief: 0.7, fade: 0.14 },
  // Dark Blade
  11321183: { relief: 0.85, fade: 0.14, tame: 0.3 },
  // Ancient Gear Golem: grey machine
  83104731: { relief: 0.8, fade: 0.12, tame: 0.65, spec: 0.35 },
  // Cyber End Dragon: silver heads cut at the edges
  1546123: { relief: 0.75, fade: 0.15, tame: 0.85, spec: 0.35, rim: 0.5 },
  // Elemental HERO Neos: white suit
  89943723: { relief: 0.85, fade: 0.1, tame: 0.8, spec: 0.4, rim: 0.55 },
  // Toon Summoned Skull: flat toon colors, less relief
  91842653: { relief: 0.65, fade: 0.15 },
  // Magician of Black Chaos
  30208479: { relief: 0.85, fade: 0.13 },
  // Winged Dragon, Guardian of the Fortress #1
  87796900: { relief: 0.9, fade: 0.13 },
  // Vorse Raider
  14898066: { relief: 0.85, fade: 0.12 },
  // Battle Ox
  5053103: { relief: 0.85, fade: 0.14 },
  // Gilford the Lightning
  36354008: { relief: 0.85, fade: 0.13, tame: 0.3 },
  // Harpie Queen
  75064463: { relief: 0.9, fade: 0.11 },
  // Rogue Doll: thin limbs and a cape that tear into strings seen over the shoulder; flatter, wider fade
  91939608: { relief: 0.6, fade: 0.14 },
};

const NONE: FigureTune = {};

/** The tune for a card id (an empty object when it has none). */
export function tuneFor(id: number | undefined): FigureTune {
  return (id !== undefined && FIGURE_TUNES[id]) || NONE;
}

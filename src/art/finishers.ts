// Signature finishers: the winning blow's slow-motion replay plays a finisher styled after
// the attacking monster's Type (a Dragon breathes, a Spellcaster fires through magic
// circles, a Warrior cuts an X...). Pure: which finisher a card gets, and its name.
// The cinematics themselves live with the attack styles in runtime.ts (FINISHERS).
import type { CardInfo } from '../eds/types';

export type FinisherKind = 'breath' | 'arcane' | 'holy' | 'blade' | 'salvo' | 'rend' | 'quake' | 'storm' | 'meteor' | 'tide' | 'dive' | 'curse' | 'swarm';

/** Every monster Type in the game, and the finisher it gets. */
export const RACE_FINISHER: Record<string, FinisherKind> = {
  Dragon: 'breath',
  Wyrm: 'breath',
  'Divine-Beast': 'breath',
  'Sea Serpent': 'tide',
  Aqua: 'tide',
  Fish: 'tide',
  Spellcaster: 'arcane',
  Psychic: 'arcane',
  Fairy: 'holy',
  Warrior: 'blade',
  'Beast-Warrior': 'blade',
  Machine: 'salvo',
  Cyberse: 'salvo',
  Beast: 'rend',
  Reptile: 'rend',
  Dinosaur: 'quake',
  Rock: 'quake',
  Thunder: 'storm',
  Pyro: 'meteor',
  'Winged Beast': 'dive',
  Fiend: 'curse',
  Zombie: 'curse',
  Insect: 'swarm',
  Plant: 'swarm',
};

/** A card with a Type the table does not know: its Attribute decides. */
const ELEMENT_FINISHER: Record<string, FinisherKind> = {
  FIRE: 'meteor',
  WATER: 'tide',
  WIND: 'dive',
  EARTH: 'quake',
  LIGHT: 'holy',
  DARK: 'curse',
  DIVINE: 'holy',
};

export const FINISHER_TITLE: Record<FinisherKind, string> = {
  breath: 'DRAGON BREATH',
  arcane: 'ARCANE BEAM',
  holy: 'JUDGMENT LIGHT',
  blade: 'FINAL SLASH',
  salvo: 'FULL BARRAGE',
  rend: 'SAVAGE REND',
  quake: 'EARTHSHATTER',
  storm: 'THUNDER JUDGMENT',
  meteor: 'METEOR FALL',
  tide: 'TIDAL CRASH',
  dive: 'SKY DIVE',
  curse: 'SOUL REAPER',
  swarm: 'HIVE STORM',
};

/** Types whose finisher keeps the kind's look under a name of their own. */
const RACE_TITLE: Record<string, string> = {
  Plant: 'THORN STORM',
  Zombie: 'GRAVE GRASP',
  'Sea Serpent': 'SERPENT TIDE',
  Psychic: 'MIND BREAKER',
  Cyberse: 'DATA STORM',
  Reptile: 'VENOM FANG',
  Dinosaur: 'PRIMAL STAMPEDE',
  'Beast-Warrior': 'BEAST BLADE',
  'Divine-Beast': 'DIVINE BREATH',
};

export interface Finisher {
  kind: FinisherKind;
  title: string;
}

/** The finisher a monster plays when its blow wins the duel (null: not a monster). `name`: an iconic card keeps its own move. */
export function finisherFor(info: Pick<CardInfo, 'kind' | 'race' | 'attribute'> | undefined, name = ''): Finisher | null {
  if (info && info.kind !== 'monster') return null;
  const race = info?.race ?? '';
  const own = ICONIC[name]?.kind;
  const kind = own ?? RACE_FINISHER[race] ?? ELEMENT_FINISHER[(info?.attribute ?? '').toUpperCase()] ?? 'blade';
  return { kind, title: own ? FINISHER_TITLE[kind] : (RACE_TITLE[race] ?? FINISHER_TITLE[kind]) };
}

// ---------- ending cutscenes ----------
// The winning blow from an iconic monster, or from its duelist's Ace, gets a cutscene before
// its finisher: the art slams across the screen with a title line, a hero shot as it powers up
// (with its own wind-up), it shouts its attack, then the finisher plays.

/** The iconic Speed Duel monsters with an ending cutscene: a title line, and their own finisher when the Type's does not fit. */
export const ICONIC: Record<string, { line: string; kind?: FinisherKind }> = {
  'Blue-Eyes White Dragon': { line: 'The legendary white dragon' },
  'Blue-Eyes Ultimate Dragon': { line: 'Three heads, one roar' },
  'Dark Magician': { line: 'The ultimate wizard' },
  'Dark Magician Girl': { line: "The magician's apprentice" },
  'Red-Eyes Black Dragon': { line: 'The dragon of potential' },
  'Summoned Skull': { line: 'The fiend of the storm', kind: 'storm' },
  'Black Luster Soldier': { line: 'The soldier of chaos' },
  'Gaia The Fierce Knight': { line: 'The fierce knight charges' },
  'Gaia the Dragon Champion': { line: 'Knight and dragon as one' },
  'Buster Blader': { line: 'The dragon destroyer' },
  Jinzo: { line: 'The trap-breaker', kind: 'storm' },
  'Harpie Lady Sisters': { line: 'Three sisters of the sky' },
  'Celtic Guardian': { line: 'The elf swordsman' },
  Kuriboh: { line: 'Small, but never alone' },
  'Cyber Dragon': { line: 'The machine dragon', kind: 'breath' },
  'Cyber End Dragon': { line: 'The end of evolution', kind: 'breath' },
  'Elemental HERO Neos': { line: 'The hero from the stars' },
  'Elemental HERO Flame Wingman': { line: 'Hero of flame and wind', kind: 'meteor' },
  'Elemental HERO Sparkman': { line: 'The hero of light', kind: 'storm' },
  'Dark Paladin': { line: 'The dark magic blade' },
  'Thousand Dragon': { line: 'A thousand years of power' },
  'Curse of Dragon': { line: 'The cursed dragon' },
  'Magician of Black Chaos': { line: 'Master of black chaos' },
  'Meteor Black Dragon': { line: 'Red eyes, meteor heart', kind: 'meteor' },
  'Flame Swordsman': { line: 'The blade of flame', kind: 'blade' },
  'Gearfried the Iron Knight': { line: 'The iron knight' },
  'Insect Queen': { line: 'Queen of the swarm' },
  'Ancient Gear Golem': { line: 'The ancient colossus', kind: 'quake' },
  'Obelisk the Tormentor': { line: 'The god of destruction', kind: 'quake' },
  'Slifer the Sky Dragon': { line: 'The sky dragon god', kind: 'storm' },
  'The Winged Dragon of Ra': { line: 'The sun god', kind: 'meteor' },
};

export interface Finale {
  /** the line under its name */
  line: string;
  /** how grand: the Ace's bond level (1..5); an iconic card that is not an Ace plays at 2 */
  lv: number;
  ace: boolean;
}

/** The ending cutscene a winning blow gets (null: none, the finisher plays alone). */
export function finaleFor(name: string, ace: { lv: number } | null): Finale | null {
  if (!name) return null;
  const icon = ICONIC[name];
  if (ace) return { line: icon?.line ?? 'Your Ace ends it', lv: Math.max(1, Math.min(5, Math.floor(ace.lv))), ace: true };
  return icon ? { line: icon.line, lv: 2, ace: false } : null;
}

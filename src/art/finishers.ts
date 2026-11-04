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

/** The finisher a monster plays when its blow wins the duel (null: not a monster). */
export function finisherFor(info: Pick<CardInfo, 'kind' | 'race' | 'attribute'> | undefined): Finisher | null {
  if (info && info.kind !== 'monster') return null;
  const race = info?.race ?? '';
  const kind = RACE_FINISHER[race] ?? ELEMENT_FINISHER[(info?.attribute ?? '').toUpperCase()] ?? 'blade';
  return { kind, title: RACE_TITLE[race] ?? FINISHER_TITLE[kind] };
}

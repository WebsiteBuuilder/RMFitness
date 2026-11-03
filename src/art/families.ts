// Effect families: every Spell, Trap, monster effect and Skill of the Speed Duel pool
// sorted by what its text does (destroy, banish, revive, burn, ATK up, negate...), so
// a card without its own preset still plays a cinematic that fits it. Pure: no three.js,
// no DOM (the coverage script and the tests read it in node).
import { card } from '../eds/db';
import type { CardInfo } from '../eds/types';

export type FxFamily =
  | 'destroy'
  | 'destroyAll'
  | 'banish'
  | 'bounce'
  | 'toDeck'
  | 'revive'
  | 'special'
  | 'fusion'
  | 'ritual'
  | 'search'
  | 'draw'
  | 'heal'
  | 'burn'
  | 'powerUp'
  | 'powerDown'
  | 'negate'
  | 'equip'
  | 'terrain'
  | 'aura'
  | 'protect'
  | 'position'
  | 'control'
  | 'chance'
  | 'discard'
  | 'lock'
  | 'token'
  | 'insight';

/** Every family, in the order the 3D Card Viewer lists them, with a short label. */
export const FX_FAMILIES: readonly { id: FxFamily; label: string }[] = [
  { id: 'destroy', label: 'Destroy one' },
  { id: 'destroyAll', label: 'Destroy all' },
  { id: 'banish', label: 'Banish' },
  { id: 'bounce', label: 'Bounce to hand' },
  { id: 'toDeck', label: 'Return to Deck' },
  { id: 'revive', label: 'Revive' },
  { id: 'special', label: 'Special Summon' },
  { id: 'fusion', label: 'Fusion' },
  { id: 'ritual', label: 'Ritual' },
  { id: 'token', label: 'Tokens' },
  { id: 'search', label: 'Search' },
  { id: 'draw', label: 'Draw' },
  { id: 'heal', label: 'Gain LP' },
  { id: 'burn', label: 'Burn damage' },
  { id: 'powerUp', label: 'ATK/DEF up' },
  { id: 'powerDown', label: 'ATK/DEF down' },
  { id: 'negate', label: 'Negate' },
  { id: 'equip', label: 'Equip' },
  { id: 'terrain', label: 'Field terrain' },
  { id: 'aura', label: 'Continuous aura' },
  { id: 'protect', label: 'Protection' },
  { id: 'position', label: 'Position change' },
  { id: 'control', label: 'Control change' },
  { id: 'chance', label: 'Coin / dice' },
  { id: 'discard', label: 'Discard / mill' },
  { id: 'lock', label: 'Lock' },
  { id: 'insight', label: 'Reveal / look' },
];

/** The landscape a Field Spell (or a field-placing Skill) paints behind everything. */
export type Terrain = 'volcano' | 'ocean' | 'forest' | 'sky' | 'holy' | 'shadow' | 'arcane' | 'tech' | 'wasteland' | 'cosmos';
export const TERRAINS: readonly Terrain[] = ['volcano', 'ocean', 'forest', 'sky', 'holy', 'shadow', 'arcane', 'tech', 'wasteland', 'cosmos'];

export interface FxClass {
  family: FxFamily;
  /** Field Spells: the terrain */
  terrain?: Terrain;
  /** board-wide effects: whose monsters it reaches */
  scope?: 'opp' | 'all' | 'oppAtk' | 'own';
}

const hash = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The part of a card's text that says what it does (summoning conditions and Fusion/Xyz material lines dropped). */
export function effectText(info: Pick<CardInfo, 'desc' | 'kind' | 'sub'>): string {
  let t = (info.desc ?? '').replace(/\r/g, '');
  if (info.kind === 'monster') {
    // material lines: "Blue-Eyes" + "Blue-Eyes", "2 Level 4 monsters", "1 Tuner + 1+ non-Tuner monsters"
    if (/Fusion|Xyz|Synchro|Link/.test(info.sub)) t = t.replace(/^[^\n]*?(monsters?|"[^"]+")(\s*\n|$)/, (m) => (/\+|\d\+?\s|Level|Tuner|"/.test(m) && m.length < 220 ? '' : m));
    t = t.replace(/^("[^"]+"\s*\+\s*)+"[^"]+"/, '');
    // summoning conditions and lore-ish sentences that are not effects
    t = t
      .split(/(?<=\.)\s+|\n/)
      .filter((s) => !/^(Cannot be (Normal|Special) Summoned|Must (first )?be|Must be Special Summoned|This card cannot be Normal Summoned|\(This card is always treated|Cannot be Special Summoned)/i.test(s.trim()))
      .join(' ');
  }
  // "Activate only when...", "You can only activate 1 ... per turn": when, not what
  t = t.replace(/(^|\.\s+)(Activate only|You can only (activate|use)|You can only control)[^.]*\./gi, '$1');
  // Skills: the bracketed timing note and "Activate this Skill..." say when, not what
  t = t.replace(/\[[^\]]*\]/g, ' ').replace(/Activate (this Skill|the following Skill\(s\))[^.]*\./gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

/** Its effect clause: what follows the activation condition (":") and the cost or target (";"). */
function effectPart(t: string): string {
  const first = t.split(/(?<=\.)\s/)[0] ?? t;
  const semi = first.lastIndexOf(';');
  if (semi >= 0) return first.slice(semi + 1) + ' ' + t.slice(first.length);
  const colon = first.lastIndexOf(':');
  if (colon >= 0) return first.slice(colon + 1) + ' ' + t.slice(first.length);
  return t;
}

// distinctive families: when the text says it at all, it is what the card is about
const STRONG: [FxFamily, RegExp][] = [
  ['token', /Special Summon[^.]{0,80}Tokens?\b|\bTokens?\b[^.]{0,40}Special Summon/i],
  ['fusion', /Fusion Summon|Fusion Material[^.]{0,40}(banish|send|return)/i],
  ['ritual', /Ritual Summon/i],
  ['control', /(take|gain) control|control of (it|that|1|the)|switch control|control until the End Phase/i],
  ['chance', /toss(es)? a coin|toss(es)? \d+ coins?|roll(s)? a (six-sided )?die|roll(s)? \d+ (six-sided )?dice|\bcoin toss|\bdie roll/i],
];

// verb families: the one said first in the effect clause wins
const VERBS: [FxFamily, RegExp][] = [
  ['negate', /\bnegat(e|es|ed)\b|\bcounter(s)? the\b|cannot be activated in response/i],
  ['destroyAll', /destroy (all|as many|both|up to \d|\d+ (cards|monsters)|them|those|all of)|destroy (every|each) /i],
  ['destroy', /\bdestroy(s|ed)?\b/i],
  ['banish', /\bbanish(es|ed)?\b|remove[^.]{0,30}from play/i],
  ['bounce', /return[^.]{0,60}\bto (the|its|their|his|your|your opponent's)( owner's| owners'| owner\(s\)'s)? hand/i],
  ['toDeck', /(shuffle|return|place)[^.]{0,60}(into|to|on (the )?(top|bottom) of) (the|your|their|its owner's|his|your opponent's)( owner's)? (Main )?Deck|into the Deck/i],
  ['revive', /Special Summon[^.]{0,80}(from (your|either|the|their|his|your opponent's) (GY|Graveyard)|from (the|either player's|your) Graveyard|in (your|either) (GY|Graveyard))/i],
  ['special', /Special Summon/i],
  ['search', /add[^.]{0,90}\bto (your|the|their) hand/i],
  ['draw', /\bdraws? (\d+|a|one|two|three|1|2|3|cards?)\b|\bdraw (until|for each)/i],
  ['heal', /\bgain(s)? (\d+ )?(LP|Life Points)|increase your (LP|Life Points)|gain LP|recover(s)? \d+|gain[^.]{0,30}LP equal/i],
  ['burn', /\binflict(s)? (\d+|damage)|inflicts? damage|take(s)? \d+ damage|lose(s)? \d+ (LP|Life Points)|damage to your opponent|damage equal to/i],
  ['position', /change[^.]{0,50}(battle )?position|to (face-down )?Defense Position|to (face-up )?Attack Position|face-down Defense|flip[^.]{0,20}face-down/i],
  ['powerDown', /\blose(s)? \d+ ATK|ATK (to )?0\b|ATK becomes 0|loses? ATK|ATK[^.]{0,30}becomes? 0|\bhalve(d)?\b[^.]{0,30}ATK|ATK[^.]{0,20}halved|-\d+ ATK|lose[^.]{0,20}ATK/i],
  ['powerUp', /\bgain(s)? \d+ ATK|gains? ATK|\+\d+ ATK|ATK[^.]{0,30}(doubled|double|becomes? (\d+|equal|twice))|gain(s)? ATK|increase[^.]{0,20}ATK|ATK and DEF|ATK\/DEF/i],
  ['protect', /cannot be destroyed|cannot be targeted|take(s)? no (battle )?damage|unaffected by|battle damage[^.]{0,20}(becomes 0|is halved|halved)|reduce[^.]{0,30}damage|damage[^.]{0,40}(to|becomes) 0|no effect damage/i],
  ['lock', /cannot (declare an attack|attack|be used|activate|Normal Summon|Special Summon|Set|Summon|conduct)|end the Battle Phase|skip (their|your|the|his)|cannot change|must attack|neither player can/i],
  ['discard', /\bdiscard(s)?\b|send[^.]{0,60}from[^.]{0,30}(hand|Deck|top of)[^.]{0,30}to the (GY|Graveyard)|mill|excavate|send[^.]{0,30}top[^.]{0,30}(GY|Graveyard)/i],
  ['equip', /\bequip(s|ped)?\b/i],
];
// said anywhere, but only when nothing above is
const WEAK: [FxFamily, RegExp][] = [
  ['powerUp', /attack (your opponent )?directly|attack[^.]{0,30}(once again|twice)|second attack|attack (every|all) monsters?|piercing/i],
  ['insight', /look at|reveal|declare (1|a|one) (card|Type|Attribute|Monster|number|Level|card type)|check|guess|name becomes|Level (of|becomes)|increase the Level/i],
  ['aura', /Spell Counter|Counter|place[^.]{0,30}counter|each time|once per turn|during (each|your) (Standby|End) Phase/i],
];

function firstVerb(t: string): FxFamily | null {
  let best: FxFamily | null = null;
  let at = Infinity;
  for (const [f, re] of VERBS) {
    const m = re.exec(t);
    if (m && m.index < at) (best = f), (at = m.index);
  }
  return best;
}

function terrainOf(info: Pick<CardInfo, 'name' | 'desc'>): Terrain {
  // its name first (Umi, Wasteland, Geartown...), then the monsters it powers up
  // ("All Fish, Sea Serpent... gain 200 ATK/DEF, also all Pyro lose...")
  const byName: [Terrain, RegExp][] = [
    ['wasteland', /Wasteland|Desert|Sogen|Jurassic|Ruins(?! -)|Grave(?!keeper)|Straight to the Grave/i],
    ['ocean', /Umi|Ocean|Sea|Depths|Atlantis|Fisherman/i],
    ['volcano', /Volcan|Blaze|Inferno|Flame|Fire/i],
    ['tech', /Gear|Factory|Hangar|Recycling|Magnetic|SPYRAL|Resort|Patent|Skyscraper|City|Machina|Cyber|\bZone\b/i],
    ['sky', /Mountain|Peak|Hunting Ground|Sky|Cloud/i],
    ['forest', /Forest|Village|Jungle|Garden/i],
    ['holy', /Paradise|Light|Sanctuary|Heaven|Temple|Gate/i],
    ['shadow', /Yami|Dark|Necrovalley|Pandemonium|Tomb|Night|Ojama/i],
    ['arcane', /Rainbow|Crystal|Oracle|Magic|Mystic|Prediction|Spell/i],
    ['cosmos', /Space|Metamor|Star|Galaxy|Otherworld/i],
  ];
  for (const [ter, re] of byName) if (re.test(info.name)) return ter;
  const d = info.desc.replace(/\[[^\]]*\]/g, '');
  const g = /gain/i.exec(d);
  const t = g ? d.slice(0, g.index) : d;
  const byText: [Terrain, RegExp][] = [
    ['volcano', /\bFIRE\b|Pyro/],
    ['ocean', /\bWATER\b|Aqua|Fish|Sea Serpent/],
    ['shadow', /\bDARK\b|Fiend|Zombie/],
    ['holy', /\bLIGHT\b|Fairy/],
    ['sky', /\bWIND\b|Winged Beast|Dragon|Thunder/],
    ['forest', /\bEARTH\b|Insect|Plant|Beast|Dinosaur/],
    ['tech', /Machine|Cyberse/],
    ['arcane', /Spellcaster|Spell Counter/],
    ['wasteland', /Rock|Warrior/],
  ];
  for (const [ter, re] of byText) if (re.test(t)) return ter;
  return TERRAINS[hash(info.name) % TERRAINS.length];
}

function scopeOf(t: string): FxClass['scope'] {
  if (/all (face-up )?Attack Position monsters your opponent controls|opponent's Attack Position monsters/i.test(t)) return 'oppAtk';
  if (/monsters? your opponent controls|your opponent's (field|monsters)|opponent's side/i.test(t)) return 'opp';
  if (/monsters? (you control|on your (side of the )?field)/i.test(t)) return 'own';
  if (/on the field|both players|each player/i.test(t)) return 'all';
  return undefined;
}

/** What a card's effect does, from its text. Every card gets a family (none falls through to a generic look). */
export function classify(info: Pick<CardInfo, 'name' | 'desc' | 'kind' | 'sub'> & Partial<Pick<CardInfo, 'vanilla'>>): FxClass {
  const all = effectText(info);
  const eff = effectPart(all);
  const out = (family: FxFamily): FxClass => {
    const scope = family === 'destroyAll' || family === 'powerDown' || family === 'powerUp' || family === 'position' || family === 'bounce' || family === 'banish' || family === 'toDeck' ? scopeOf(eff) : undefined;
    return scope ? { family, scope } : { family };
  };
  // card kinds that decide the look on their own
  if (info.kind === 'spell' && info.sub === 'Field') return { family: 'terrain', terrain: terrainOf(info) };
  if (info.sub === 'Skill' && /(start|begin)[^.]{0,40}Duel[^.]{0,80}Field (Zone|Spell)|Field Spell[^.]{0,60}(Field Zone|start of the Duel)/i.test(info.desc)) return { family: 'terrain', terrain: terrainOf(info) };
  if (info.kind === 'spell' && info.sub === 'Ritual') return { family: 'ritual' };
  if (info.kind === 'spell' && info.sub === 'Equip') return { family: 'equip' };
  if (/Union monster|equip this card to|equip it to|equipped to/i.test(all) && info.kind === 'monster' && /^(Once per turn, )?(You can )?(target 1|equip)/i.test(eff)) return { family: 'equip' };
  for (const [f, re] of STRONG) if (re.test(eff)) return out(f);
  const v = firstVerb(eff) ?? firstVerb(all);
  // "Target 1 monster in your GY; Special Summon it": a revival
  if (v === 'special' && /(target|select|choose)[^;.]{0,90}(GY|Graveyard|banished)[^;.]{0,40};/i.test(all)) return out('revive');
  if (v) return out(v);
  for (const [f, re] of STRONG) if (re.test(all)) return out(f);
  for (const [f, re] of WEAK) if (re.test(all)) return out(f);
  // what is left: lasting effects and conditions; continuous cards hum, the rest bless
  if (info.sub === 'Continuous' || info.kind === 'monster' || info.sub === 'Skill') return { family: 'aura' };
  return { family: 'insight' };
}

/** A card's effect family by name (null: no such card, or a monster with no effect). */
export function fxFamilyOf(name: string): FxClass | null {
  const info = card(name);
  if (!info) return null;
  if (info.kind === 'monster' && info.vanilla) return null;
  return classify(info);
}

/** Display names of Skill characters (the card list cuts them at 13 letters). */
const CHARACTERS: Record<string, string> = {
  'Dr. Vellian C': 'Dr. Vellian Crowler',
  'Syrus Truesda': 'Syrus Truesdale',
  'Paradox Broth': 'Paradox Brothers',
  'Bastion Misaw': 'Bastion Misawa',
  'Chazz Princet': 'Chazz Princeton',
  'Jesse Anderso': 'Jesse Anderson',
  'Zane Truesdal': 'Zane Truesdale',
  'The Supreme K': 'The Supreme King',
  'Abidos the Th': 'Abidos the Third',
  'Chumley Huffi': 'Chumley Huffington',
  'Thelonious Vi': 'Thelonious Viper',
  'Tyranno Hassl': 'Tyranno Hassleberry',
  'Lumis and Umb': 'Lumis and Umbra',
};
export function characterName(raw: string | undefined): string {
  return raw ? (CHARACTERS[raw] ?? raw) : '';
}

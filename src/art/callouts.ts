// Attack callouts: signature monsters shout their attack's name across the screen as the
// attack is declared ("White Lightning!"), and the attacker's Mate yells it along with them.
// Pure (no DOM here, but for the voice and the setting): the tests read it as it is.
//
// Only monsters with a famous attack get one, plus each duelist's Ace (see src/ace), which
// shouts its own attack name whatever card it is. The voice is the phone's own speech engine
// (free, on the phone, no service), and follows the Sound setting.

/** The shout of each signature monster in the Speed Duel card pool. */
export const CALLOUTS: Record<string, string> = {
  'Blue-Eyes White Dragon': 'White Lightning!',
  'Blue-Eyes Ultimate Dragon': 'Neutron Blast!',
  'Dark Magician': 'Dark Magic Attack!',
  'Dark Magician Girl': 'Dark Burning Attack!',
  'Magician of Black Chaos': 'Chaos Scepter Blast!',
  'Dark Paladin': 'Dark Magic Blade!',
  'Red-Eyes Black Dragon': 'Inferno Fire Blast!',
  'Summoned Skull': 'Lightning Strike!',
  'Toon Summoned Skull': 'Toon Lightning Strike!',
  Jinzo: 'Cyber Energy Shock!',
  'Harpie Lady Sisters': 'Triangle Ecstasy Spark!',
  'Cyber Harpie Lady': 'Cyber Talon Strike!',
  'Cyber Dragon': 'Evolution Burst!',
  'Cyber End Dragon': 'Super Strident Blaze!',
  'Elemental HERO Neos': 'Wrath of Neos!',
  'Elemental HERO Neos Alius': 'Alius Impact!',
  'Elemental HERO Flame Wingman': 'Skydive Scorcher!',
  'Elemental HERO Shining Flare Wingman': 'Shining Shoot!',
  'Elemental HERO Sparkman': 'Static Shockwave!',
  'Elemental HERO Avian': 'Quill Cyclone!',
  'Elemental HERO Burstinatrix': 'Burstfire!',
  'Elemental HERO Clayman': 'Clay Fist!',
  'Elemental HERO Bladedge': 'Slice and Dice!',
  'Elemental HERO Wildheart': 'Wild Slash!',
  'Destiny HERO - Plasma': 'Plasma Pulse!',
  'Black Luster Soldier': 'Chaos Blade!',
  'Gaia The Fierce Knight': 'Spiral Spear Strike!',
  'Gaia the Dragon Champion': 'Dragon Spiral Spear!',
  'Buster Blader': 'Dragon Destroyer Sword!',
  'Flame Swordsman': 'Salamandra Slash!',
  'Celtic Guardian': 'Elf Sword Slash!',
  'Gilford the Lightning': 'Lightning Crash Sword!',
  'Gearfried the Iron Knight': 'Iron Blade Strike!',
  'Valkyrion the Magna Warrior': 'Magna Saber!',
  'Time Wizard': 'Time Magic!',
  'Thousand Dragon': 'Noxious Vapor!',
  Kuriboh: 'Kuri Kuri!',
  'Baby Dragon': 'Baby Flame!',
  'Vorse Raider': 'Vorse Axe!',
  'Battle Ox': 'Axe Crusher!',
  'La Jinn the Mystical Genie of the Lamp': 'Genie Punch!',
  'Slifer the Sky Dragon': 'Thunder Force!',
  'Obelisk the Tormentor': 'Fist of Fate!',
  'The Winged Dragon of Ra': 'Blaze Cannon!',
  'Barrel Dragon': 'Barrel Shot!',
  'XYZ-Dragon Cannon': 'X-Y-Z Hyper Destruction!',
  'Insect Queen': "Queen's Swarm!",
  "Alligator's Sword Dragon": 'Alligator Fire!',
  'Rainbow Dragon': 'Rainbow Refraction!',
  'Rainbow Dark Dragon': 'Dark Rainbow Refraction!',
  'Armed Dragon LV7': 'Armed Dragon Thunder!',
  'Ancient Gear Golem': 'Mechanized Melee!',
  'Vampire Lord': 'Bloodsucker Bite!',
  'Meteor Dragon': 'Meteor Crash!',
  'Meteor Black Dragon': 'Meteor Inferno!',
  'Crystal Beast Sapphire Pegasus': 'Sapphire Tornado!',
  'Hamon, Lord of Striking Thunder': 'Shining Thunder!',
  'Uria, Lord of Searing Flames': 'Hyper Blaze!',
  'Raviel, Lord of Phantasms': 'Shimmering Scraper!',
  'Masked Beast Des Gardius': 'Masked Fury!',
  'Curse of Dragon': 'Dragon Flame!',
  'Gate Guardian': 'Tidal Thunder Gale!',
  'Sanga of the Thunder': 'Thunder Crash!',
  Kazejin: 'Wind Cutter!',
  Suijin: 'Tidal Wave Slash!',
  'Kaiser Glider': 'Golden Wing!',
  'Big Shield Gardna': 'Shield Bash!',
  'Mystical Elf': 'Mystic Light!',
  'Lava Golem': 'Molten Fist!',
};

export interface Callout {
  /** the shout, as shown and said ("White Lightning!") */
  text: string;
  /** the monster that shouts it */
  card: string;
  /** an Ace shouts (whatever card it is) */
  ace: boolean;
}

/** The callout of a monster's attack, or null when it has none. `attackName`: the art engine's name for it (used for an Ace). */
export function calloutFor(name: string, attackName: string, ace = false): Callout | null {
  if (!name) return null;
  const sig = CALLOUTS[name];
  if (sig) return { text: sig, card: name, ace };
  if (!ace || !attackName) return null;
  const t = attackName.trim().replace(/[!.]+$/, '');
  return t ? { text: `${t}!`, card: name, ace } : null;
}

/** The Mate's line: it yells the end of the shout along with its monster ("LIGHTNING!!"). */
export function mateEcho(text: string): string {
  const words = text.replace(/[!.]+$/, '').toUpperCase().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return `${words[0] ?? ''}!!`;
  const last = words[words.length - 1];
  // (a short last word takes the one before with it: "MAGIC ATTACK", not "ATTACK")
  return `${last.length <= 6 && words.length > 2 ? `${words[words.length - 2]} ${last}` : last}!!`;
}

/** The shout in lines of words: one line, or two balanced ones when it is long (each word slams in on its own beat). */
export function shoutLines(text: string): string[][] {
  const words = text.split(/\s+/).filter(Boolean);
  if (text.length <= 16 || words.length < 2) return [words];
  let best = 1;
  let bestW = Infinity;
  for (let i = 1; i < words.length; i++) {
    const w = Math.max(words.slice(0, i).join(' ').length, words.slice(i).join(' ').length);
    if (w < bestW) (bestW = w), (best = i);
  }
  return [words.slice(0, best), words.slice(best)];
}

/** How big the shout is drawn (in vw): sized by its longest line so the whole shout fits a phone's width. */
export function shoutSize(text: string): number {
  const n = Math.max(...shoutLines(text).map((l) => l.join(' ').length));
  return Math.max(4.6, Math.min(13, 105 / Math.max(8, n)));
}

// ---------- the setting ----------
export type CalloutMode = 'voice' | 'text' | 'off';
const KEY = 'eds.callouts';
const EVT = 'eds-callouts';

export function calloutMode(): CalloutMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'text' || v === 'off' ? v : 'voice';
  } catch {
    return 'voice';
  }
}

export function setCalloutMode(v: CalloutMode) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* storage blocked */
  }
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVT));
}
export const CALLOUT_EVT = EVT;
export const NEXT_CALLOUT: Record<CalloutMode, CalloutMode> = { voice: 'text', text: 'off', off: 'voice' };
export const CALLOUT_LABEL: Record<CalloutMode, string> = { voice: 'Voice + text', text: 'Text only', off: 'Off' };

// ---------- the voice ----------
/** A voice's pitch for a monster: big beasts growl low, small ones squeak (0.5..1.6). */
export function voicePitch(level: number, name: string): number {
  if (/Kuriboh|Baby|Toon/.test(name)) return 1.6;
  if (/Girl|Lady|Harpie|Elf|Burstinatrix/.test(name)) return 1.3;
  return Math.max(0.5, Math.min(1.1, 1.15 - level * 0.07));
}

// the voice itself (now or never, never late) lives in voice.ts
export { speakShout, stopShout, voiceWarm, warmVoice } from './voice';

/** Fired on the window when a callout plays: the field Mate cheers it after the cinematic. */
export const CALLOUT_SHOUT = 'eds-callout-shout';
export interface CalloutShout {
  /** the seat whose monster shouted */
  seat: 0 | 1;
  text: string;
}
